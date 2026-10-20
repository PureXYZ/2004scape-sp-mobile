// fsx: the one file-system call SaveStore needs that Java does not offer (ports the iOS SaveStore's
// renamex_np(RENAME_SWAP), docs/ANDROID.md §1 Saves on disk).
//
// renameat2(RENAME_EXCHANGE) swaps two paths in one step: SaveStore writes the new save to a hidden temp file beside the
// old one, exchanges them, then renames the temp (now the previous version) to <file>.bak. The save path therefore always
// holds a complete file, the old one or the new one, even if the app is killed in between, and nothing is copied. iOS has
// a hard-link fallback for file systems without the swap; on Android link() is refused by SELinux (EACCES), so
// SaveStore.kt falls back to copy + rename instead when this returns EINVAL, ENOSYS or EOPNOTSUPP.
//
// The syscall is made directly: bionic's renameat2() wrapper is only declared with _GNU_SOURCE, and the syscall number is
// the same on every kernel that has the call (Linux 3.15+; ext4 and f2fs, the file systems of /data, support exchange).
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

// Fsx.exchange(a, b): 0 when the two paths were swapped, else the errno (ENOENT when either is missing).
JNIEXPORT jint JNICALL Java_io_github_purexyz_scape2004_Fsx_exchange(JNIEnv *env, jclass type, jstring a, jstring b) {
    (void) type;
    const char *pathA = (*env)->GetStringUTFChars(env, a, NULL);
    const char *pathB = (*env)->GetStringUTFChars(env, b, NULL);
    if (pathA == NULL || pathB == NULL) {
        // (an OutOfMemoryError is pending in Java)
        if (pathA != NULL) (*env)->ReleaseStringUTFChars(env, a, pathA);
        if (pathB != NULL) (*env)->ReleaseStringUTFChars(env, b, pathB);
        return ENOMEM;
    }
    long result = syscall(__NR_renameat2, AT_FDCWD, pathA, AT_FDCWD, pathB, RENAME_EXCHANGE);
    int error = result == 0 ? 0 : errno;
    (*env)->ReleaseStringUTFChars(env, a, pathA);
    (*env)->ReleaseStringUTFChars(env, b, pathB);
    return error;
}
