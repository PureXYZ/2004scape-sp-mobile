// SaveStore on the JVM (a temp folder): the iOS path rules, atomic writes with .bak (through a swap, and through the
// copy fallback used where the swap is missing), the unchanged-bytes skip, DELETE keeping a .bak, the index's hidden-file
// rules and the stale-temp sweep.
package io.github.purexyz.scape2004

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SaveStoreTest {
    /** renameat2(RENAME_EXCHANGE) emulated with three renames (fine single-threaded), counting its uses. */
    private class SwapOps : NioFileOps() {
        var swaps = 0
        override fun exchange(a: File, b: File): Int {
            if (!a.exists() || !b.exists()) return FileOps.ENOENT
            val aside = File(b.parentFile, ".swap-${java.util.UUID.randomUUID()}")
            rename(b, aside)
            rename(a, b)
            rename(aside, a)
            swaps++
            return 0
        }
    }

    private lateinit var dir: File
    private lateinit var root: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("savestore").toFile()
        root = File(dir, "Documents")
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    private fun assertFailure(expected: SaveStore.Failure, block: () -> Unit) {
        try {
            block()
            fail("expected $expected")
        } catch (failure: SaveStore.Failure) {
            assertEquals(expected, failure)
        }
    }

    // ------------------------------------------------------------------------------------------------ path rules

    @Test
    fun pathRulesMatchIos() {
        assertEquals(listOf("players", "main", "zezima.sav"), SaveStore.components("players/main/zezima.sav"))
        assertEquals(listOf("bots", "main", "bots.sav.bak"), SaveStore.components("bots/main/bots.sav.bak"))
        for (bad in listOf("", "/etc/passwd", "players//a.sav", "players/../x", "../x", "./x", "players/.hidden",
            ".x", "a\\b", "a\u0000b", "players/", "a/./b", "x".repeat(256), "a/" + "b".repeat(1023))) {
            assertNull("refused: $bad", SaveStore.components(bad))
        }
        assertNotNull(SaveStore.components("x".repeat(255)))
        // 1024 bytes in all is the limit: UTF-8 bytes, not characters
        assertNull(SaveStore.components("é".repeat(513)))
    }

    @Test
    fun invalidPathsAreRefusedByEveryOperation() {
        val store = SaveStore(root, NioFileOps())
        assertFailure(SaveStore.Failure.InvalidPath) { store.read("../outside") }
        assertFailure(SaveStore.Failure.InvalidPath) { store.write("/abs", bytes(1)) }
        assertFailure(SaveStore.Failure.InvalidPath) { store.delete("a//b") }
        assertFailure(SaveStore.Failure.InvalidPath) { store.info(".tmp") }
        assertFalse(File(dir, "outside").exists())
    }

    // ------------------------------------------------------------------------------------------------ writes

    @Test
    fun firstWriteThenBackupThroughTheSwap() {
        val ops = SwapOps()
        val store = SaveStore(root, ops)
        assertTrue(store.write("players/main/zezima.sav", bytes(1, 2, 3)))
        val file = File(root, "players/main/zezima.sav")
        assertArrayEquals(bytes(1, 2, 3), file.readBytes())
        assertFalse("no backup after the first save", File(file.path + ".bak").exists())
        assertEquals(0, ops.swaps) // ENOENT: the first save is a plain rename

        assertTrue(store.write("players/main/zezima.sav", bytes(4, 5)))
        assertEquals(1, ops.swaps)
        assertArrayEquals(bytes(4, 5), file.readBytes())
        assertArrayEquals(bytes(1, 2, 3), File(file.path + ".bak").readBytes())

        assertTrue(store.write("players/main/zezima.sav", bytes(6)))
        assertArrayEquals(bytes(6), file.readBytes())
        assertArrayEquals("the .bak is the previous version", bytes(4, 5), File(file.path + ".bak").readBytes())
        assertNoTempFiles()
    }

    @Test
    fun aPlayerSaveIsDurableBeforeTheWriteReturns() {
        // The swap and the .bak's rename are folder entries: the file's fsync does not make them durable, so the folder
        // is synced after them, before write() returns (the 204). The bots' store is not synced, as on iOS.
        for (swap in listOf(true, false)) {
            root.deleteRecursively()
            val calls = ArrayList<String>()
            val ops = object : NioFileOps() {
                val inner = SwapOps()
                override fun exchange(a: File, b: File): Int =
                    (if (swap) inner.exchange(a, b) else FileOps.ENOSYS).also { calls.add("exchange $it") }

                override fun rename(from: File, to: File) {
                    super.rename(from, to)
                    if (!from.name.startsWith(".swap-")) calls.add("rename ${if (to.name.startsWith(".")) "temp" else to.name}")
                }

                override fun syncFolder(folder: File) {
                    calls.add("sync ${folder.relativeTo(root).path}")
                }
            }
            val store = SaveStore(root, ops)
            store.write("players/main/zezima.sav", bytes(1))
            assertEquals("swap=$swap: first save", listOf("exchange ${if (swap) FileOps.ENOENT else FileOps.ENOSYS}", "rename zezima.sav", "sync players/main"), calls)
            calls.clear()
            store.write("players/main/zezima.sav", bytes(2))
            val expected = if (swap) {
                listOf("exchange 0", "rename zezima.sav.bak", "sync players/main")
            } else {
                listOf("exchange ${FileOps.ENOSYS}", "rename zezima.sav.bak", "rename zezima.sav", "sync players/main")
            }
            assertEquals("swap=$swap: the folder is synced after the save and its .bak are in place", expected, calls)
            calls.clear()
            assertFalse(store.write("players/main/zezima.sav", bytes(2)))
            assertEquals("unchanged: nothing written, nothing synced", emptyList<String>(), calls)
            store.write("bots/main/bots.sav", bytes(1))
            store.write("bots/main/bots.sav", bytes(2))
            assertFalse("bots.sav is not synced", calls.any { it.startsWith("sync") })
        }
        // a failed sync is logged, never a failed save: the new save is in place
        val failing = object : NioFileOps() {
            override fun syncFolder(folder: File) = throw java.io.IOException("simulated")
        }
        val store = SaveStore(root, failing)
        assertTrue(store.write("players/main/woody.sav", bytes(3)))
        assertArrayEquals(bytes(3), store.read("players/main/woody.sav"))
    }

    @Test
    fun withoutTheSwapTheBackupIsCopied() {
        val store = SaveStore(root, NioFileOps()) // exchange → ENOSYS
        store.write("bots/main/bots.sav", bytes(1))
        store.write("bots/main/bots.sav", bytes(2))
        store.write("bots/main/bots.sav", bytes(3))
        assertArrayEquals(bytes(3), store.read("bots/main/bots.sav"))
        assertArrayEquals(bytes(2), store.read("bots/main/bots.sav.bak"))
        assertNoTempFiles()
    }

    @Test
    fun unchangedBytesAreSkippedAndKeepTheBackup() {
        val store = SaveStore(root, SwapOps())
        store.write("players/main/a.sav", bytes(1))
        store.write("players/main/a.sav", bytes(2))
        val before = File(root, "players/main/a.sav").lastModified()
        assertFalse("identical bytes are not written", store.write("players/main/a.sav", bytes(2)))
        assertArrayEquals(bytes(1), store.read("players/main/a.sav.bak"))
        assertEquals(before, File(root, "players/main/a.sav").lastModified())
    }

    @Test
    fun anEmptyPreviousFileIsNeverKeptAsTheBackup() {
        // The Files app imports a file by createDocument (an empty placeholder) and then a write: through the swap and
        // through the copy fallback, the placeholder must not replace a deleted save's .bak, nor leave a 0-byte .bak.
        for (ops in listOf(SwapOps(), NioFileOps())) {
            root.deleteRecursively()
            val store = SaveStore(root, ops)
            store.write("players/main/zezima.sav", bytes(1, 2, 3))
            store.delete("players/main/zezima.sav") // the deleted character: zezima.sav.bak is its only copy
            File(root, "players/main/zezima.sav").createNewFile() // createDocument("zezima.sav")
            assertTrue(store.write("players/main/zezima.sav", bytes(4, 5)))
            assertArrayEquals(bytes(4, 5), store.read("players/main/zezima.sav"))
            assertArrayEquals("$ops: the deleted save's .bak is kept", bytes(1, 2, 3), store.read("players/main/zezima.sav.bak"))
            File(root, "players/main/woody.sav").createNewFile()
            assertTrue(store.write("players/main/woody.sav", bytes(7)))
            assertArrayEquals(bytes(7), store.read("players/main/woody.sav"))
            assertFalse("$ops: no 0-byte .bak for a new name", File(root, "players/main/woody.sav.bak").exists())
            assertNoTempFiles()
        }
    }

    @Test
    fun emptyWritesAndFoldersAreRefused() {
        val store = SaveStore(root, SwapOps())
        assertFailure(SaveStore.Failure.EmptyBody) { store.write("players/main/a.sav", ByteArray(0)) }
        File(root, "players/main/folder.sav").mkdirs()
        assertFailure(SaveStore.Failure.InvalidPath) { store.write("players/main/folder.sav", bytes(1)) }
        assertTrue(File(root, "players/main/folder.sav").isDirectory)
    }

    @Test
    fun aFailedWriteLeavesTheSaveAndNoTempFile() {
        val ops = object : NioFileOps() {
            override fun rename(from: File, to: File) {
                if (from.name.endsWith(".tmp") && !to.name.endsWith(".bak")) throw java.io.IOException("simulated")
                super.rename(from, to)
            }
        }
        val store = SaveStore(root, NioFileOps())
        store.write("players/main/a.sav", bytes(1))
        val failing = SaveStore(root, ops)
        try {
            failing.write("players/main/a.sav", bytes(2))
            fail("expected an Io failure")
        } catch (failure: SaveStore.Failure.Io) {
            assertTrue(failure.message!!, failure.message!!.startsWith("rename failed: simulated"))
        }
        assertArrayEquals(bytes(1), store.read("players/main/a.sav"))
        assertNoTempFiles()
    }

    @Test
    fun readAndInfo() {
        val store = SaveStore(root, SwapOps())
        assertFailure(SaveStore.Failure.NotFound) { store.read("players/main/none.sav") }
        assertFailure(SaveStore.Failure.NotFound) { store.info("players/main/none.sav") }
        store.write("players/main/a.sav", bytes(1, 2, 3, 4))
        assertEquals(4L, store.info("players/main/a.sav").size)
        assertFailure(SaveStore.Failure.NotFound) { store.read("players/main") } // a folder is not a save
    }

    // ------------------------------------------------------------------------------------------------ delete

    @Test
    fun deleteKeepsABackupAndDeletingTheBackupRemovesIt() {
        val store = SaveStore(root, SwapOps())
        store.write("players/main/a.sav", bytes(1))
        store.write("players/main/a.sav", bytes(2))
        store.delete("players/main/a.sav")
        assertFalse(File(root, "players/main/a.sav").exists())
        assertArrayEquals("the deleted file replaced the older backup", bytes(2), store.read("players/main/a.sav.bak"))
        store.delete("players/main/a.sav.bak")
        assertFalse(File(root, "players/main/a.sav.bak").exists())
        assertFailure(SaveStore.Failure.NotFound) { store.delete("players/main/a.sav") }
    }

    // ------------------------------------------------------------------------------------------------ index

    @Test
    fun indexListsRegularFilesSortedWithoutHiddenOnes() {
        val store = SaveStore(root, SwapOps())
        store.write("players/main/zezima.sav", bytes(1, 2))
        store.write("players/main/zezima.sav", bytes(3))
        store.write("bots/main/bots.sav", bytes(9, 9, 9))
        store.write("players/main/abc.sav", bytes(7))
        File(root, "players/main/.zezima.sav.1234.tmp").writeBytes(bytes(1))
        File(root, ".hidden/inner").mkdirs()
        File(root, ".hidden/inner/x.sav").writeBytes(bytes(1))
        val index = store.index()
        assertEquals(listOf("bots/main/bots.sav", "players/main/abc.sav", "players/main/zezima.sav", "players/main/zezima.sav.bak"), index.map { it.path })
        assertEquals(listOf(3L, 1L, 1L, 2L), index.map { it.size })
        val now = System.currentTimeMillis()
        assertTrue(index.all { now - it.modified in -2_000..60_000 }) // milliseconds since 1970
    }

    @Test
    fun staleTempFilesAreSweptOnlyWhenOld() {
        val store = SaveStore(root, SwapOps())
        val old = File(root, "players/main/.a.sav.old.tmp").apply { parentFile!!.mkdirs(); writeBytes(bytes(1)) }
        old.setLastModified(System.currentTimeMillis() - 120_000)
        val fresh = File(root, "players/main/.a.sav.new.tmp").apply { writeBytes(bytes(1)) }
        val kept = File(root, "players/main/a.tmp").apply { writeBytes(bytes(1)) }
        store.removeStaleTempFiles()
        assertFalse(old.exists())
        assertTrue(fresh.exists())
        assertTrue("not hidden: not ours", kept.exists())
    }

    @Test
    fun changesAreReportedWithTheirFolder() {
        val store = SaveStore(root, SwapOps())
        val seen = ArrayList<String>()
        store.onChange = { seen.add(it) }
        store.write("players/main/a.sav", bytes(1))
        store.write("players/main/a.sav", bytes(1)) // unchanged: no notice
        store.delete("players/main/a.sav")
        assertEquals(listOf("players/main", "players/main"), seen)
    }

    @Test
    fun concurrentWritesToDifferentSavesAllLand() {
        val store = SaveStore(root, SwapOps())
        val threads = (0 until 8).map { n ->
            Thread {
                repeat(20) { round -> store.write("players/main/p$n.sav", bytes(n, round + 1)) }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        for (n in 0 until 8) {
            assertArrayEquals(bytes(n, 20), store.read("players/main/p$n.sav"))
            assertArrayEquals(bytes(n, 19), store.read("players/main/p$n.sav.bak"))
        }
    }

    private fun assertNoTempFiles() {
        val temps = root.walkTopDown().filter { it.isFile && it.name.startsWith(".") }.toList()
        assertTrue("temp files left: $temps", temps.isEmpty())
    }
}
