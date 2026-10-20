// ggml's CPU backend on Android. llama.cpp b11297's Android prebuilt is built with
// GGML_BACKEND_DL and GGML_CPU_ALL_VARIANTS: its CPU backend is seven libraries, one per CPU generation
// (libggml-cpu-android_armv8.0_1.so ... armv9.2_2.so), and nothing runs until one of them is loaded. Upstream picks the best
// by scanning a directory (ggml_backend_load_all_from_path), but the app keeps its native libraries inside the APK
// (useLegacyPackaging = false: stored, page-aligned, never extracted), so there is no directory to scan. The libraries are
// asked by name instead: the linker namespace of the app's class loader searches base.apk!/lib/arm64-v8a. Each variant is
// opened, asked for its score (0: this CPU lacks a feature it was built for), and closed; the best is then loaded for good
// (ggml_backend_load_best's rule: the highest score wins).
#include <dlfcn.h>

#include <android/log.h>

#include "ggml-backend.h"
#include "lc_llm.h"

namespace {

// best first, as the scores usually rank them (the score decides, not this order)
const char *const kVariants[] = {
    "libggml-cpu-android_armv9.2_2.so", "libggml-cpu-android_armv9.2_1.so", "libggml-cpu-android_armv9.0_1.so",
    "libggml-cpu-android_armv8.6_1.so", "libggml-cpu-android_armv8.2_2.so", "libggml-cpu-android_armv8.2_1.so",
    "libggml-cpu-android_armv8.0_1.so",
};

typedef int (*score_fn)();

}  // namespace

const char *lc_load_cpu_backend() {
    const char *best = nullptr;
    int best_score = 0;
    for (const char *name : kVariants) {
        void *handle = dlopen(name, RTLD_NOW | RTLD_LOCAL);
        if (handle == nullptr) {
            __android_log_print(ANDROID_LOG_INFO, "LostCity", "[llama] no %s: %s", name, dlerror());
            continue;
        }
        auto score = reinterpret_cast<score_fn>(dlsym(handle, "ggml_backend_score"));
        const int value = score != nullptr ? score() : 0;
        dlclose(handle);
        if (value > best_score) {
            best_score = value;
            best = name;
        }
    }
    if (best == nullptr) {
        return nullptr;
    }
    // (ggml logs "load_backend: loaded CPU backend from <name>" through the log callback lc_init installed)
    return ggml_backend_load(best) != nullptr ? best : nullptr;
}
