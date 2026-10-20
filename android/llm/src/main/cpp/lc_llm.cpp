// The bots' on-device chat model, the C++ core: ios/LostCity/LocalModel.swift's `load` and `run` (and their helpers) ported
// token for token (docs/ARCHITECTURE.md §7.1). Read lc_llm.h first. Where a line
// here differs from the Swift, the comment says why; every other difference is a bug.
#include "lc_llm.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <set>
#include <vector>

#include <unistd.h>

#include "ggml-backend.h"
#include "gguf.h"
#include "llama.h"

namespace {

// Kotlin's `abortRequested || suspended` (LocalModel.kt keeps the two under its lock and stores their OR here in the same
// locked block, so a pause can never be lost between a look and a store).
std::atomic<bool> g_stop{false};

std::once_flag g_init_once;
const char *g_variant = nullptr;
lc_log_fn g_log = nullptr;
void *g_log_user = nullptr;

double ms_since(int64_t start_ns) {
    return double(lc_now_ns() - start_ns) / 1e6;
}

}  // namespace

struct lc_model {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    const llama_vocab *vocab = nullptr;
    // (owned when the model came from a file descriptor: llama.cpp does not close a FILE* it was given)
    FILE *file = nullptr;
    std::vector<llama_token_data> candidates;
    // the tokens the context holds (the last prompt and what was decoded after it)
    std::vector<llama_token> cached;
    // the model keeps a recurrent state (Qwen3.5's linear-attention layers): only a pure extension reuses the context
    bool recurrent = false;
    int ctx_size = 1024;
    int batch_size = 512;
    // the running request's deadline, for the abort callback (INT64_MAX between requests)
    std::atomic<int64_t> deadline_ns{INT64_MAX};
};

int64_t lc_now_ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void lc_set_stop(bool stop) {
    g_stop.store(stop);
}

const char *lc_init(lc_log_fn log, void *user) {
    std::call_once(g_init_once, [&] {
        // (Swift: llama_log_set, then llama_backend_init, once, before the first load; ggml's own lines come through the
        // same callback: llama_log_set installs it for ggml too)
        g_log = log;
        g_log_user = user;
        llama_log_set([](ggml_log_level level, const char *text, void *) { g_log(int(level), text, g_log_user); }, nullptr);
#ifdef __ANDROID__
        // The prebuilt is built with GGML_BACKEND_DL: llama.cpp has no backend until one is loaded, and a load without
        // one fails with "no backends are loaded".
        g_variant = lc_load_cpu_backend();
#else
        // The macOS prebuilt links its backends into libggml.
        g_variant = "";
#endif
        llama_backend_init();
    });
    return g_variant;
}

lc_model *lc_load(const lc_load_params &p, lc_load_result &r) {
    const int64_t started = lc_now_ns();
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = p.gpu_layers;
    mp.use_extra_bufts = p.repack;
    // (an empty, null-terminated list: no offload device at all. The Mac's prebuilt registers Metal, which iOS uses and
    // Android does not have; the harness must run what Android runs)
    static ggml_backend_dev_t no_devices[] = {nullptr};
    if (p.cpu_only) {
        mp.devices = no_devices;
    }

    FILE *file = nullptr;
    llama_model *model = nullptr;
    if (p.fd >= 0) {
        // The GGUF inside another file (an APK's stored asset): llama.cpp reads it through a FILE* positioned at its first
        // byte, its own copy of the descriptor (the caller closes the original when this returns).
        const int fd = dup(p.fd);
        file = fd >= 0 ? fdopen(fd, "rb") : nullptr;
        if (file == nullptr) {
            if (fd >= 0) {
                close(fd);
            }
            r.error = "the model did not load (no file)";
            return nullptr;
        }
        // mmap places every tensor at its offset in the file, so the GGUF's data section must sit at an offset the CPU
        // buffers' alignment divides (32 bytes); llama.cpp refuses to map it otherwise. Peek at it first and read the model
        // into memory instead when it is not (about 200 MB more of the app's memory, but it works).
        gguf_init_params gp = {/*no_alloc*/ true, /*ctx*/ nullptr};
        if (fseeko(file, p.offset, SEEK_SET) != 0) {
            fclose(file);
            r.error = "the model did not load (seek)";
            return nullptr;
        }
        gguf_context *peek = gguf_init_from_file_ptr(file, gp);
        if (peek == nullptr) {
            fclose(file);
            r.error = "the model did not load (not a GGUF)";
            return nullptr;
        }
        const size_t data_offset = gguf_get_data_offset(peek);
        gguf_free(peek);
        const size_t align = ggml_backend_buft_get_alignment(ggml_backend_cpu_buffer_type());
        const bool aligned = data_offset % align == 0;
        if (p.mmap == 1 && !aligned) {
            fclose(file);
            r.error = "the model is not " + std::to_string(align) + "-byte aligned in the APK";
            return nullptr;
        }
        r.mmap = p.mmap == 1 || (p.mmap == -1 && aligned);
        if (!r.mmap) {
            r.read_reason = p.mmap == 0 ? "read: mmap off" : "read: not " + std::to_string(align) + "-byte aligned in the APK";
        }
        mp.load_mode = r.mmap ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE;
        fseeko(file, p.offset, SEEK_SET);
        model = llama_model_load_from_file_ptr(file, mp);
    } else {
        r.mmap = p.mmap != 0;
        if (!r.mmap) {
            r.read_reason = "read: mmap off";
        }
        mp.load_mode = r.mmap ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE;
        model = llama_model_load_from_file(p.path.c_str(), mp);
    }
    if (model == nullptr) {
        if (file != nullptr) {
            fclose(file);
        }
        r.error = "the model did not load";
        return nullptr;
    }
    const int64_t model_loaded = lc_now_ns();
    r.model_ms = ms_since(started);

    const int ctx_size = std::max(256, p.ctx);
    const int batch_size = std::min(512, ctx_size);
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = uint32_t(ctx_size);
    cp.n_batch = uint32_t(batch_size);
    cp.n_ubatch = uint32_t(batch_size);
    cp.n_seq_max = 1;
    // Only the last token's logits are read: one output. (The default, an output per token of a 512-token batch, reserves
    // 512 x 248k logits: a 490 MB compute buffer instead of about 40.)
    cp.n_outputs_max = 1;
    cp.n_outputs_max_per_seq = 1;
    cp.n_threads = p.threads;
    cp.n_threads_batch = p.batch_threads;
    cp.no_perf = true;
    llama_context *ctx = llama_init_from_model(model, cp);
    if (ctx == nullptr) {
        llama_model_free(model);
        if (file != nullptr) {
            fclose(file);
        }
        r.error = "no context for the model";
        return nullptr;
    }

    auto *m = new lc_model();
    m->model = model;
    m->ctx = ctx;
    m->file = file;
    m->vocab = llama_model_get_vocab(model);
    m->recurrent = llama_model_is_recurrent(model) || llama_model_is_hybrid(model);
    m->candidates.assign(size_t(llama_vocab_n_tokens(m->vocab)), llama_token_data{0, 0, 0});
    m->ctx_size = ctx_size;
    m->batch_size = batch_size;
    // [Android] llama.cpp's abort callback: a decode stops inside a prompt batch at a pause or at the deadline. A 300-token
    // prompt is one Metal call on the iPhone but 1.4-3 s of CPU on a phone; without it a pause would wait for the batch.
    // It changes only how soon a stop takes effect, never what the page hears.
    llama_set_abort_callback(
        ctx,
        [](void *data) -> bool {
            auto *model = static_cast<lc_model *>(data);
            return g_stop.load(std::memory_order_relaxed) || lc_now_ns() >= model->deadline_ns.load(std::memory_order_relaxed);
        },
        m);

    r.n_layer = llama_model_n_layer(model);
    r.ctx = ctx_size;
    r.recurrent = m->recurrent;
    r.context_ms = ms_since(model_loaded);
    r.total_ms = ms_since(started);
    return m;
}

void lc_free(lc_model *m) {
    if (m == nullptr) {
        return;
    }
    // (Swift: the context, then the model)
    if (m->ctx != nullptr) {
        llama_free(m->ctx);
    }
    if (m->model != nullptr) {
        llama_model_free(m->model);
    }
    if (m->file != nullptr) {
        fclose(m->file);
    }
    delete m;
}

namespace {

std::vector<llama_token> tokenize(const llama_vocab *vocab, const std::string &text, bool special) {
    std::vector<llama_token> tokens(text.size() + 8);
    int n = llama_tokenize(vocab, text.c_str(), int32_t(text.size()), tokens.data(), int32_t(tokens.size()), false, special);
    if (n < 0) {
        tokens.assign(size_t(-n), 0);
        n = llama_tokenize(vocab, text.c_str(), int32_t(text.size()), tokens.data(), int32_t(tokens.size()), false, special);
    }
    tokens.resize(size_t(std::max(0, n)));
    return tokens;
}

void append(std::vector<llama_token> &to, const std::vector<llama_token> &tokens) {
    to.insert(to.end(), tokens.begin(), tokens.end());
}

// Qwen's chat template (ChatML) as its own template renders it: the turns (trimmed by Kotlin), the template's markers as
// special tokens, the turns' text as plain text (a chat line can never become a marker). Thinking off: the empty think
// block; with the note (the template's enable_thinking): the block opened for the model to write in.
std::vector<llama_token> prompt_tokens(const llama_vocab *vocab, const std::string &system, const std::string &user, bool note) {
    std::vector<llama_token> out = tokenize(vocab, "<|im_start|>system\n", true);
    append(out, tokenize(vocab, system, false));
    append(out, tokenize(vocab, "<|im_end|>\n<|im_start|>user\n", true));
    append(out, tokenize(vocab, user, false));
    append(out, tokenize(vocab, note ? "<|im_end|>\n<|im_start|>assistant\n<think>\n" : "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n", true));
    return out;
}

int32_t decode(lc_model *m, const llama_token *tokens, size_t count) {
    std::vector<llama_token> chunk(tokens, tokens + count);
    return llama_decode(m->ctx, llama_batch_get_one(chunk.data(), int32_t(chunk.size())));
}

std::string piece(const llama_vocab *vocab, llama_token token) {
    std::vector<char> buffer(64);
    int n = llama_token_to_piece(vocab, token, buffer.data(), int32_t(buffer.size()), 0, false);
    if (n < 0) {
        buffer.assign(size_t(-n), 0);
        n = llama_token_to_piece(vocab, token, buffer.data(), int32_t(buffer.size()), 0, false);
    }
    return std::string(buffer.data(), size_t(std::max(0, n)));
}

// One line of the chat's characters (274's chat: ASCII 32-122), at most max_chars.
std::string grammar_text(int max_chars) {
    return "root ::= [ -z]{1," + std::to_string(max_chars) + "}";
}

llama_sampler *make_chain(const lc_model *m, const lc_gen_params &p) {
    llama_sampler *chain = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(chain, llama_sampler_init_top_k(p.top_k));
    llama_sampler_chain_add(chain, llama_sampler_init_penalties(llama_vocab_n_tokens(m->vocab), p.repeat_last_n, p.repeat_penalty, 0, 0));
    llama_sampler_chain_add(chain, llama_sampler_init_top_p(p.top_p, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_temp(p.temp));
    llama_sampler_chain_add(chain, llama_sampler_init_dist(p.seed));
    return chain;
}

// The last token's logits filtered by the grammar, then sampled by the chain (the rare case: the chain's own choice broke
// the grammar). The chain does not accept the token here.
llama_token sample_with_grammar(lc_model *m, llama_sampler *chain, llama_sampler *grammar) {
    const float *logits = llama_get_logits_ith(m->ctx, -1);
    for (size_t i = 0; i < m->candidates.size(); i++) {
        m->candidates[i] = llama_token_data{llama_token(i), logits[i], 0};
    }
    llama_token_data_array array = {m->candidates.data(), m->candidates.size(), -1, false};
    llama_sampler_apply(grammar, &array);
    llama_sampler_apply(chain, &array);
    if (array.selected < 0 || size_t(array.selected) >= array.size) {
        return llama_vocab_eos(m->vocab);
    }
    return array.data[array.selected].id;
}

bool grammar_allows(llama_sampler *grammar, llama_token token) {
    llama_token_data single = {token, 1, 0};
    llama_token_data_array array = {&single, 1, -1, false};
    llama_sampler_apply(grammar, &array);
    return std::isfinite(array.data[0].logit);
}

// Swift's shouldStop: the stop flag first, then the deadline.
lc_status check(const lc_model *m) {
    if (g_stop.load()) {
        return LC_ABORTED;
    }
    if (lc_now_ns() >= m->deadline_ns.load()) {
        return LC_TIMEOUT;
    }
    return LC_OK;
}

// A decode that failed: the context is cleared (what it holds is no longer known) and the reason is the page's. rc 2 is
// llama.cpp's "aborted" (the abort callback, Android only): a pause or the deadline, as the check would have said.
lc_status decode_failed(lc_model *m, int32_t rc, lc_gen_result &r) {
    llama_memory_clear(llama_get_memory(m->ctx), true);
    m->cached.clear();
    if (rc == 2) {
        return g_stop.load() ? LC_ABORTED : LC_TIMEOUT;
    }
    r.error = "decode " + std::to_string(rc);
    return LC_FAILED;
}

lc_status generate(lc_model *m, const lc_gen_params &p, lc_gen_result &r) {
    const std::vector<llama_token> prompt = prompt_tokens(m->vocab, p.system, p.user, p.note);
    r.prompt_tokens = int(prompt.size());
    if (int(prompt.size()) + p.max_tokens + (p.note ? p.note_max_tokens + 2 : 0) >= m->ctx_size) {
        r.error = "the prompt is too long (" + std::to_string(prompt.size()) + " tokens)";
        return LC_FAILED;
    }

    // What the context holds of this prompt already (its recurrent layers may refuse to be cut back: start afresh).
    llama_memory_t memory = llama_get_memory(m->ctx);
    long keep = 0;
    while (size_t(keep) < m->cached.size() && size_t(keep) < prompt.size() && m->cached[size_t(keep)] == prompt[size_t(keep)]) {
        keep++;
    }
    if (size_t(keep) >= prompt.size()) {
        keep = long(prompt.size()) - 1;  // (the last token is evaluated again, for its logits)
    }
    // (a recurrent or hybrid model, as Qwen3.5 is, keeps one state for the whole sequence: only a pure extension of what it
    // holds may reuse it. A cut back clears the recurrent state but keeps the attention's, and the reply is computed from
    // the two out of step)
    if (m->recurrent && size_t(keep) != m->cached.size()) {
        keep = 0;
    }
    if (keep > 0 && !llama_memory_seq_rm(memory, 0, llama_pos(keep), -1)) {
        keep = 0;
    }
    if (keep <= 0) {
        keep = 0;
        llama_memory_clear(memory, true);
    }
    m->cached.assign(prompt.begin(), prompt.begin() + keep);
    r.reused_tokens = int(keep);

    const int64_t prompt_start = lc_now_ns();
    size_t at = size_t(keep);
    while (at < prompt.size()) {
        if (lc_status stop = check(m); stop != LC_OK) {
            return stop;
        }
        const size_t end = std::min(prompt.size(), at + size_t(m->batch_size));
        const int32_t rc = decode(m, prompt.data() + at, end - at);
        if (rc != 0) {
            return decode_failed(m, rc, r);
        }
        m->cached.insert(m->cached.end(), prompt.begin() + long(at), prompt.begin() + long(end));
        at = end;
    }
    llama_synchronize(m->ctx);  // (decode may return before the backend is done)
    r.prompt_ms = ms_since(prompt_start);

    llama_sampler *chain = make_chain(m, p);
    llama_sampler *grammar = llama_sampler_init_grammar(m->vocab, grammar_text(p.max_chars).c_str(), "root");
    struct Samplers {
        llama_sampler *chain, *grammar;
        ~Samplers() {
            llama_sampler_free(chain);
            if (grammar != nullptr) {
                llama_sampler_free(grammar);
            }
        }
    } samplers{chain, grammar};

    const int64_t note_start = lc_now_ns();
    if (p.note) {
        // the note: sampled freely (no grammar) to the think block's close, then the blank line before the reply
        const std::vector<llama_token> close = tokenize(m->vocab, "</think>", true);
        const std::vector<llama_token> blank = tokenize(m->vocab, "\n\n", false);
        std::string note;
        bool closed = false;
        while (r.note_tokens < p.note_max_tokens) {
            if (lc_status stop = check(m); stop != LC_OK) {
                return stop;
            }
            const llama_token token = llama_sampler_sample(chain, m->ctx, -1);
            if (close.size() == 1 && token == close[0]) {
                closed = true;
                break;
            }
            if (llama_vocab_is_eog(m->vocab, token)) {
                break;
            }
            note += piece(m->vocab, token);
            r.note_tokens++;
            const int32_t rc = decode(m, &token, 1);
            if (rc != 0) {
                return decode_failed(m, rc, r);
            }
            m->cached.push_back(token);
        }
        // (the close as the model wrote it, or for it at the note's limit, after the note's own line break as trained:
        // "note\n</think>\n\n"; the blank line as trained)
        const bool note_ends_line = !note.empty() && note.back() == '\n';
        std::vector<llama_token> tail;
        if (closed || note_ends_line) {
            tail = close;
        } else {
            tail = tokenize(m->vocab, "\n", false);
            append(tail, close);
        }
        append(tail, blank);
        for (llama_token token : closed ? blank : tail) {
            llama_sampler_accept(chain, token);  // (a sampled close is accepted already)
        }
        const int32_t rc = decode(m, tail.data(), tail.size());
        if (rc != 0) {
            return decode_failed(m, rc, r);
        }
        append(m->cached, tail);
        r.note = note;
        r.closed = closed;
        llama_synchronize(m->ctx);  // (the close's decode is the note's time)
        r.note_ms = ms_since(note_start);
    }

    // (the think block's markers end the reply: Qwen's are plain added tokens, not control ones, and their text would pass
    // the grammar, so a confused model could start a second note there)
    std::set<llama_token> markers;
    for (const char *marker : {"<think>", "</think>"}) {
        const std::vector<llama_token> tokens = tokenize(m->vocab, marker, true);
        if (tokens.size() == 1) {
            markers.insert(tokens[0]);
        }
    }
    const int64_t generate_start = lc_now_ns();
    std::string bytes;
    while (r.generated_tokens < p.max_tokens) {
        if (lc_status stop = check(m); stop != LC_OK) {
            return stop;
        }
        // (llama.cpp's own way: the chain picks a token and accepts it, in C; only a token the grammar refuses makes the
        // whole vocabulary go through the grammar. The chain has then accepted both the refused token and the new one,
        // as on iOS)
        llama_token token = llama_sampler_sample(chain, m->ctx, -1);
        if (grammar != nullptr && !grammar_allows(grammar, token)) {
            token = sample_with_grammar(m, chain, grammar);
            llama_sampler_accept(chain, token);
            r.resampled++;
        }
        if (llama_vocab_is_eog(m->vocab, token) || llama_vocab_is_control(m->vocab, token) || markers.count(token) != 0) {
            break;
        }
        if (grammar != nullptr) {
            llama_sampler_accept(grammar, token);
        }
        const std::string text = piece(m->vocab, token);
        const size_t newline = text.find_first_of("\n\r");
        if (newline != std::string::npos) {
            bytes.append(text, 0, newline);
            break;
        }
        bytes += text;
        r.generated_tokens++;
        if (int(bytes.size()) >= p.max_chars || r.generated_tokens >= p.max_tokens) {
            break;
        }
        const int32_t rc = decode(m, &token, 1);
        if (rc != 0) {
            return decode_failed(m, rc, r);
        }
        m->cached.push_back(token);
    }
    r.generate_ms = ms_since(generate_start);
    r.text = bytes;
    return LC_OK;
}

}  // namespace

lc_status lc_generate(lc_model *m, const lc_gen_params &p, lc_gen_result &r) {
    m->deadline_ns.store(p.deadline_ns);
    const lc_status status = generate(m, p, r);
    m->deadline_ns.store(INT64_MAX);
    return status;
}
