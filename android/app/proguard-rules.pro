# R8 rules for the release build (app/build.gradle.kts). The defaults (proguard-android-optimize.txt) already keep
# @androidx.annotation.Keep classes and members, the manifest's components and View constructors.

# JNI: native methods keep their names and their classes (fsx.c's renameat2, the llama.cpp layer): the JNI symbol
# names are derived from them.
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

# Anything C calls back into by name (GetMethodID / GetFieldID), or reflection reaches, is marked
# @androidx.annotation.Keep where it is declared, so the rule stays next to the code.

# @JavascriptInterface (the page bridge is a WebMessageListener, so none today; kept for any test hook that uses one)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Readable stack traces in the log file and logcat.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
