# The bots' on-device chat model's native library, liblcllm (docs/ARCHITECTURE.md §7.1): the C++
# core (lc_llm.cpp) and its JNI layer, linked against llama.cpp b11297's upstream prebuilts, which
# android/scripts/fetch-llama.sh puts in android/build/vendor/llama-b11297.
#
#   Android (AGP's externalNativeBuild, android/llm/build.gradle.kts): arm64-v8a against the official Android prebuilt;
#     libllama/libggml/libggml-base are IMPORTED (AGP packages them), the CPU backend variants are dlopen'ed at run time
#     (lc_backend_android.cpp) and packaged as jniLibs.
#   macOS (-DLC_HOST=ON; android/test/native/lm-harness.mjs): liblcllm.dylib for the Mac JVM harness, against the macOS
#     prebuilt of the same release, which links its backends itself.
cmake_minimum_required(VERSION 3.22)
project(lcllm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
option(LC_HOST "Build the macOS dylib for the Mac JVM harness" OFF)

set(LLAMA ${CMAKE_CURRENT_LIST_DIR}/../../../../build/vendor/llama-b11297)
if(NOT EXISTS ${LLAMA}/include/llama.h)
    message(FATAL_ERROR "llama.cpp is missing: run android/scripts/fetch-llama.sh (${LLAMA})")
endif()

if(LC_HOST)
    # (only jni.h: the JBR that runs Gradle ships no headers, and the NDK's jni.h is self-contained and the same ABI. It is
    # copied alone, so the rest of the NDK's sysroot never shadows the Mac's own headers)
    if(NOT DEFINED NDK_JNI_H)
        message(FATAL_ERROR "pass -DNDK_JNI_H=<ndk>/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/include/jni.h")
    endif()
    configure_file(${NDK_JNI_H} ${CMAKE_BINARY_DIR}/jni/jni.h COPYONLY)
    add_library(lcllm SHARED lc_llm.cpp lc_llm_jni.cpp)
    target_include_directories(lcllm PRIVATE ${LLAMA}/include ${CMAKE_BINARY_DIR}/jni)
    target_link_libraries(lcllm PRIVATE ${LLAMA}/macos/libllama.dylib ${LLAMA}/macos/libggml.dylib ${LLAMA}/macos/libggml-base.dylib)
    set_target_properties(lcllm PROPERTIES BUILD_RPATH ${LLAMA}/macos)
else()
    foreach(lib llama ggml ggml-base)
        add_library(${lib} SHARED IMPORTED)
        set_target_properties(${lib} PROPERTIES IMPORTED_LOCATION ${LLAMA}/link/${ANDROID_ABI}/lib${lib}.so)
    endforeach()
    add_library(lcllm SHARED lc_llm.cpp lc_backend_android.cpp lc_llm_jni.cpp)
    target_include_directories(lcllm PRIVATE ${LLAMA}/include)
    target_link_libraries(lcllm PRIVATE llama ggml ggml-base log dl)
    # (16 KB pages: Android 15+ devices may use them; NDK 30's default too, and the prebuilt is 16 KB aligned already)
    target_link_options(lcllm PRIVATE "-Wl,-z,max-page-size=16384")
endif()
