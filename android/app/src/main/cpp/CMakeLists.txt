# The app's own native code (docs/ANDROID.md §2): fsx.c, the atomic file swap SaveStore installs saves with. The bot chat
# track adds the llama.cpp JNI layer next to it.
cmake_minimum_required(VERSION 3.22)
project(lostcity C)

add_library(fsx SHARED fsx.c)
