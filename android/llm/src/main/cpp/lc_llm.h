// The bots' on-device chat model, the C++ core (docs/ARCHITECTURE.md §7.1). It is the llama.cpp
// half of the iOS app's ios/LostCity/LocalModel.swift (`load`, `run` and their helpers), token for token: the same prompt
// template, the same sampling chain in the same order, the same grammar, the same stop rules, the same context reuse.
// Kotlin (android/botchat LocalModel.kt) keeps everything else that Swift class does: the queue, the lock, the idle
// unload, the timings' dictionary, the failure strings and the log lines.
//
// One model per process. Everything here runs on the model's thread (Kotlin's `lostcity.local-model` executor) except
// lc_set_stop, which any thread may call: it is the Swift class's `abortRequested || suspended`, read at every point
// where Swift calls `shouldStop` and, on Android, inside a prompt batch too (llama.cpp's abort callback).
//
// The same file builds for Android (against llama.cpp b11297's official Android arm64 prebuilt, CPU backends loaded by
// lc_backend_android.cpp) and for macOS (the Mac JVM harness, android/test/native/lm-harness.mjs, against the macOS
// prebuilt of the same release).
#pragma once

#include <cstdint>
#include <string>

// A line of llama.cpp's (or ggml's) own log: `level` is ggml_log_level (1 debug, 2 info, 3 warn, 4 error, 5 cont).
typedef void (*lc_log_fn)(int level, const char *text, void *user);

// Installs the log callback, loads ggml's CPU backend (Android: the best of the prebuilt's CPU variants for this phone)
// and calls llama_backend_init(). Idempotent: the first call decides. Returns the CPU variant's library name ("" on the
// Mac, whose prebuilt links its backends), or nullptr when no backend could be loaded (the model cannot run here).
const char *lc_init(lc_log_fn log, void *user);

// The stop flag (Kotlin's abortRequested || suspended, set under its lock).
void lc_set_stop(bool stop);

struct lc_load_params {
    // The GGUF: an open file descriptor and the byte offset of the GGUF in it (an APK's stored asset, or a test's padded
    // file), or, when fd < 0, a path.
    int fd = -1;
    int64_t offset = 0;
    std::string path;
    int ctx = 1024;
    int threads = 2;
    int batch_threads = 2;
    int gpu_layers = 0;
    // -1: mmap when the GGUF's data section is aligned for it in the file, else read it into memory; 0: read; 1: mmap
    // (an error when it is not aligned)
    int mmap = -1;
    // ggml's CPU weight repacking (llama_model_params.use_extra_bufts, on by default: about twice the prompt speed)
    bool repack = true;
    // No offload devices at all (the Mac harness, whose prebuilt has Metal; Android's has only CPU backends anyway)
    bool cpu_only = true;
};

struct lc_load_result {
    double total_ms = 0, model_ms = 0, context_ms = 0;
    int n_layer = 0;
    int ctx = 0;
    bool recurrent = false;
    bool mmap = false;
    // why the model is read rather than mapped ("" when mapped): the load log says it
    std::string read_reason;
    std::string error;
};

struct lc_model;

lc_model *lc_load(const lc_load_params &params, lc_load_result &result);
void lc_free(lc_model *model);

struct lc_gen_params {
    // already trimmed by Kotlin (Swift's whitespacesAndNewlines), UTF-8
    std::string system, user;
    // the model writes its note first (Kotlin decided it from the request and the model's ThinkSupport)
    bool note = false;
    // the request's deadline on std::chrono::steady_clock, in nanoseconds since its epoch
    int64_t deadline_ns = INT64_MAX;
    float temp = 0.8f, top_p = 0.9f;
    int top_k = 40;
    float repeat_penalty = 1.1f;
    int repeat_last_n = 64;
    int max_tokens = 40, max_chars = 120, note_max_tokens = 64;
    uint32_t seed = 0;
};

enum lc_status { LC_OK = 0, LC_ABORTED = 1, LC_TIMEOUT = 2, LC_FAILED = 3 };

struct lc_gen_result {
    // raw bytes, untrimmed: Kotlin decodes them (UTF-8 with replacement) and trims them, as Swift does
    std::string text, note;
    // the model closed its note itself (else it ran to note_max_tokens, or to an end of generation, and was closed for it)
    bool closed = false;
    int prompt_tokens = 0, reused_tokens = 0, generated_tokens = 0, resampled = 0, note_tokens = 0;
    double prompt_ms = 0, note_ms = 0, generate_ms = 0;
    // with LC_FAILED: "decode <rc>", "the prompt is too long (<n> tokens)"
    std::string error;
};

lc_status lc_generate(lc_model *model, const lc_gen_params &params, lc_gen_result &result);

// The current time on the clock lc_gen_params.deadline_ns is on.
int64_t lc_now_ns();

#ifdef __ANDROID__
// lc_backend_android.cpp: loads the best CPU variant; returns its name or nullptr.
const char *lc_load_cpu_backend();
#endif
