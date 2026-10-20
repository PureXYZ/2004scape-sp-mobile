# What native code reaches by name in :botchat and :llm (applied to the app's R8 run; docs/ANDROID.md §1 SDKs).
# liblcllm's JNI functions are bound by name to LlmJni's native methods.
-keepclasseswithmembernames,includedescriptorclasses class io.github.purexyz.scape2004.botchat.LlmJni {
    native <methods>;
}
# The out objects' fields are written by name (lc_llm_jni.cpp set_* helpers).
-keepclassmembers class io.github.purexyz.scape2004.botchat.LoadOut { <fields>; }
-keepclassmembers class io.github.purexyz.scape2004.botchat.GenOut { <fields>; }
-keep class io.github.purexyz.scape2004.botchat.LoadOut
-keep class io.github.purexyz.scape2004.botchat.GenOut
# llama.cpp's log callback calls LlmLog.line(int, byte[]) (found in JNI_OnLoad by name).
-keep class io.github.purexyz.scape2004.botchat.LlmLog {
    public static void line(int, byte[]);
}
