// The JNI surface of the bots' on-device chat model: android/botchat's LlmJni (LlmNative.kt)
// calls these, on Android and on the Mac JVM (the harness) alike. Text crosses as UTF-8 byte arrays both ways, never as
// Java strings: GetStringUTFChars is Modified UTF-8 (another encoding for characters outside the BMP, and for NUL), which
// would change the prompt's bytes, and NewStringUTF aborts under CheckJNI on the malformed UTF-8 a note can hold (a token
// may end in the middle of a character). No Java exception is ever thrown from here: status codes and the out objects'
// `error` fields only.
#include <jni.h>

#include <climits>
#include <cstring>
#include <string>

#ifdef __ANDROID__
#include <android/log.h>
#else
#include <cstdio>
#endif

#include "lc_llm.h"

namespace {

JavaVM *g_vm = nullptr;
// io.github.purexyz.scape2004.botchat.LlmLog.line(int level, byte[] text): llama.cpp's log lines, filtered in Kotlin (LM-16)
jclass g_log_class = nullptr;
jmethodID g_log_line = nullptr;

// llama.cpp's log callback. On a thread the JVM knows (the model's thread, which is the one that loads and generates) the
// line goes to Kotlin; ggml's own worker threads are not attached, and attaching them from here is not allowed, so their
// rare lines go to the system log (logcat on Android, stderr on the Mac) as debug output.
void log_line(int level, const char *text, void *) {
    if (text == nullptr) {
        return;
    }
    JNIEnv *env = nullptr;
    if (g_vm != nullptr && g_log_line != nullptr && g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_OK && env != nullptr) {
        const jsize length = jsize(strlen(text));
        jbyteArray bytes = env->NewByteArray(length);
        if (bytes == nullptr) {
            env->ExceptionClear();
            return;
        }
        env->SetByteArrayRegion(bytes, 0, length, reinterpret_cast<const jbyte *>(text));
        env->CallStaticVoidMethod(g_log_class, g_log_line, jint(level), bytes);
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
        }
        env->DeleteLocalRef(bytes);
        return;
    }
#ifdef __ANDROID__
    __android_log_print(ANDROID_LOG_DEBUG, "LostCity", "[llama] %s", text);
#else
    fprintf(stderr, "[llama] %s", text);
#endif
}

std::string bytes_of(JNIEnv *env, jbyteArray array) {
    if (array == nullptr) {
        return {};
    }
    const jsize length = env->GetArrayLength(array);
    std::string out(size_t(length), '\0');
    if (length > 0) {
        env->GetByteArrayRegion(array, 0, length, reinterpret_cast<jbyte *>(out.data()));
    }
    return out;
}

jbyteArray array_of(JNIEnv *env, const std::string &bytes) {
    jbyteArray array = env->NewByteArray(jsize(bytes.size()));
    if (array != nullptr && !bytes.empty()) {
        env->SetByteArrayRegion(array, 0, jsize(bytes.size()), reinterpret_cast<const jbyte *>(bytes.data()));
    }
    return array;
}

// The out objects' fields (LoadOut, GenOut: @JvmField properties, kept by the consumer ProGuard rules).
void set_double(JNIEnv *env, jobject out, const char *name, double value) {
    jfieldID field = env->GetFieldID(env->GetObjectClass(out), name, "D");
    if (field != nullptr) env->SetDoubleField(out, field, value); else env->ExceptionClear();
}

void set_int(JNIEnv *env, jobject out, const char *name, int value) {
    jfieldID field = env->GetFieldID(env->GetObjectClass(out), name, "I");
    if (field != nullptr) env->SetIntField(out, field, value); else env->ExceptionClear();
}

void set_bool(JNIEnv *env, jobject out, const char *name, bool value) {
    jfieldID field = env->GetFieldID(env->GetObjectClass(out), name, "Z");
    if (field != nullptr) env->SetBooleanField(out, field, value ? JNI_TRUE : JNI_FALSE); else env->ExceptionClear();
}

void set_bytes(JNIEnv *env, jobject out, const char *name, const std::string &value) {
    jfieldID field = env->GetFieldID(env->GetObjectClass(out), name, "[B");
    if (field == nullptr) {
        env->ExceptionClear();
        return;
    }
    jbyteArray array = array_of(env, value);
    env->SetObjectField(out, field, array);
    env->DeleteLocalRef(array);
}

// (the error texts are plain ASCII, written here: safe for NewStringUTF)
void set_string(JNIEnv *env, jobject out, const char *name, const std::string &value) {
    jfieldID field = env->GetFieldID(env->GetObjectClass(out), name, "Ljava/lang/String;");
    if (field == nullptr) {
        env->ExceptionClear();
        return;
    }
    jstring text = value.empty() ? nullptr : env->NewStringUTF(value.c_str());
    env->SetObjectField(out, field, text);
    if (text != nullptr) env->DeleteLocalRef(text);
}

}  // namespace

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
    g_vm = vm;
    JNIEnv *env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK || env == nullptr) {
        return JNI_VERSION_1_6;
    }
    // (looked up here, where the class loader that loaded this library is the one in charge: on a native thread later
    // FindClass would only see the system classes)
    jclass log_class = env->FindClass("io/github/purexyz/scape2004/botchat/LlmLog");
    if (log_class != nullptr) {
        g_log_class = reinterpret_cast<jclass>(env->NewGlobalRef(log_class));
        g_log_line = env->GetStaticMethodID(g_log_class, "line", "(I[B)V");
        env->DeleteLocalRef(log_class);
    }
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        g_log_line = nullptr;
    }
    return JNI_VERSION_1_6;
}

JNIEXPORT jstring JNICALL Java_io_github_purexyz_scape2004_botchat_LlmJni_nativeInit(JNIEnv *env, jclass) {
    const char *variant = lc_init(log_line, nullptr);
    return variant != nullptr ? env->NewStringUTF(variant) : nullptr;
}

JNIEXPORT void JNICALL Java_io_github_purexyz_scape2004_botchat_LlmJni_nativeSetStop(JNIEnv *, jclass, jboolean stop) {
    lc_set_stop(stop == JNI_TRUE);
}

JNIEXPORT jlong JNICALL Java_io_github_purexyz_scape2004_botchat_LlmJni_nativeLoad(
    JNIEnv *env, jclass, jint fd, jlong offset, jbyteArray path, jint ctx, jint threads, jint batch_threads, jint gpu_layers,
    jint mmap, jboolean repack, jboolean cpu_only, jobject out) {
    lc_load_params params;
    params.fd = fd;
    params.offset = offset;
    params.path = bytes_of(env, path);
    params.ctx = ctx;
    params.threads = threads;
    params.batch_threads = batch_threads;
    params.gpu_layers = gpu_layers;
    params.mmap = mmap;
    params.repack = repack == JNI_TRUE;
    params.cpu_only = cpu_only == JNI_TRUE;
    lc_load_result result;
    lc_model *model = lc_load(params, result);
    set_double(env, out, "totalMs", result.total_ms);
    set_double(env, out, "modelMs", result.model_ms);
    set_double(env, out, "contextMs", result.context_ms);
    set_int(env, out, "nLayer", result.n_layer);
    set_int(env, out, "ctx", result.ctx);
    set_bool(env, out, "recurrent", result.recurrent);
    set_bool(env, out, "mmap", result.mmap);
    set_string(env, out, "readReason", result.read_reason);
    set_string(env, out, "error", result.error);
    return reinterpret_cast<jlong>(model);
}

JNIEXPORT void JNICALL Java_io_github_purexyz_scape2004_botchat_LlmJni_nativeFree(JNIEnv *, jclass, jlong handle) {
    lc_free(reinterpret_cast<lc_model *>(handle));
}

JNIEXPORT jint JNICALL Java_io_github_purexyz_scape2004_botchat_LlmJni_nativeGenerate(
    JNIEnv *env, jclass, jlong handle, jbyteArray system, jbyteArray user, jboolean note, jlong remaining_ns, jfloat temp,
    jfloat top_p, jint top_k, jfloat repeat_penalty, jint repeat_last_n, jint max_tokens, jint max_chars, jint note_max_tokens,
    jint seed, jobject out) {
    auto *model = reinterpret_cast<lc_model *>(handle);
    if (model == nullptr) {
        set_string(env, out, "error", "no model");
        return LC_FAILED;
    }
    lc_gen_params params;
    params.system = bytes_of(env, system);
    params.user = bytes_of(env, user);
    params.note = note == JNI_TRUE;
    // (Kotlin's deadline is on System.nanoTime, this one on steady_clock: the time left crosses, not the instant, so the two
    // clocks never have to agree)
    const int64_t now = lc_now_ns();
    params.deadline_ns = remaining_ns > INT64_MAX - now ? INT64_MAX : now + remaining_ns;
    params.temp = temp;
    params.top_p = top_p;
    params.top_k = top_k;
    params.repeat_penalty = repeat_penalty;
    params.repeat_last_n = repeat_last_n;
    params.max_tokens = max_tokens;
    params.max_chars = max_chars;
    params.note_max_tokens = note_max_tokens;
    params.seed = uint32_t(seed);
    lc_gen_result result;
    const lc_status status = lc_generate(model, params, result);
    set_bytes(env, out, "text", result.text);
    set_bytes(env, out, "note", result.note);
    set_bool(env, out, "closed", result.closed);
    set_int(env, out, "promptTokens", result.prompt_tokens);
    set_int(env, out, "reusedTokens", result.reused_tokens);
    set_int(env, out, "generatedTokens", result.generated_tokens);
    set_int(env, out, "resampled", result.resampled);
    set_int(env, out, "noteTokens", result.note_tokens);
    set_double(env, out, "promptMs", result.prompt_ms);
    set_double(env, out, "noteMs", result.note_ms);
    set_double(env, out, "generateMs", result.generate_ms);
    set_string(env, out, "error", result.error);
    return status;
}

}  // extern "C"
