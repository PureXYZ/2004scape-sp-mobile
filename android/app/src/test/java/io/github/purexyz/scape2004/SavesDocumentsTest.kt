// SavesDocumentsProvider's rules (SavesDocumentsProvider.kt): document ids and SaveStore's
// path rules, names the Files app may create, unique names, its delete (an existing .bak is kept), and the change
// notifications' throttle (a folder and every folder above it, at once and then at most once every 2 s, the last change
// always delivered).
package io.github.purexyz.scape2004

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SavesDocumentsTest {
    @Test
    fun documentIds() {
        assertEquals("root", SaveDocuments.documentId(""))
        assertEquals("root/players/main/zezima.sav", SaveDocuments.documentId("players/main/zezima.sav"))
        assertEquals("", SaveDocuments.relative("root"))
        assertEquals("players/main/zezima.sav", SaveDocuments.relative("root/players/main/zezima.sav"))
        assertEquals("bots/main/bots.sav.bak", SaveDocuments.relative("root/bots/main/bots.sav.bak"))
    }

    @Test
    fun idsThatBreakTheRulesAreNotOurs() {
        for (id in listOf("", "saves", "rootx", "root/", "/root/a", "root//a", "root/../a", "root/a/..", "root/./a",
            "root/players/.main.sav.1234.tmp", "root/.hidden", "root/a\\b", "root/a\u0000b", "root/" + "x".repeat(256), "other/a")) {
            assertNull(id, SaveDocuments.relative(id))
        }
    }

    @Test
    fun names() {
        assertTrue(SaveDocuments.validName("zezima.sav"))
        assertTrue(SaveDocuments.validName("main (1)"))
        assertTrue(SaveDocuments.validName("x".repeat(255)))
        for (name in listOf("", ".zezima.sav", ".", "..", "a/b", "a\\b", "x".repeat(256), "é".repeat(128))) assertFalse(name, SaveDocuments.validName(name))
        assertTrue(SaveDocuments.hidden(".zezima.sav.0f.tmp"))
        assertFalse(SaveDocuments.hidden("zezima.sav.bak"))
    }

    @Test
    fun children() {
        assertTrue(SaveDocuments.isChild("root", "root/players/main/zezima.sav"))
        assertTrue(SaveDocuments.isChild("root/players", "root/players/main"))
        assertTrue(SaveDocuments.isChild("root/players", "root/players"))
        assertFalse(SaveDocuments.isChild("root/players", "root/playersx/main"))
        assertFalse(SaveDocuments.isChild("root/players/main", "root/players"))
        assertFalse(SaveDocuments.isChild("root/players", "root/../players/a"))
    }

    @Test
    fun uniqueNames() {
        val taken = setOf("zezima.sav", "zezima (1).sav", "main", "notes")
        assertEquals("woody.sav", SaveDocuments.uniqueName("woody.sav", false) { it in taken })
        assertEquals("zezima (2).sav", SaveDocuments.uniqueName("zezima.sav", false) { it in taken })
        assertEquals("main (1)", SaveDocuments.uniqueName("main", true) { it in taken })
        assertEquals("notes (1)", SaveDocuments.uniqueName("notes", false) { it in taken })
        // a folder's dot is part of its name
        assertEquals("v1.2 (1)", SaveDocuments.uniqueName("v1.2", true) { it == "v1.2" })
    }

    @Test
    fun deleteKeepsABackupThatIsAlreadyThere() {
        val dir = Files.createTempDirectory("savesdocs").toFile()
        try {
            val store = SaveStore(File(dir, "Documents"), NioFileOps())
            val changes = ArrayList<String>()
            store.onChange = { changes += it }
            val good = "the good save".toByteArray()
            val bad = "the bad save".toByteArray()
            store.write("players/main/zezima.sav", good)
            store.write("players/main/zezima.sav", bad)
            // the README's restore: delete zezima.sav, then rename zezima.sav.bak (the .bak must survive the delete)
            changes.clear()
            assertFalse(SaveDocuments.delete(store, "players/main/zezima.sav"))
            assertFalse(File(store.root, "players/main/zezima.sav").exists())
            assertArrayEquals(good, store.read("players/main/zezima.sav.bak"))
            assertEquals(listOf("players/main"), changes)
            // with no .bak beside it, a save becomes its .bak (the DELETE route)
            store.write("players/main/woody.sav", good)
            assertTrue(SaveDocuments.delete(store, "players/main/woody.sav"))
            assertFalse(File(store.root, "players/main/woody.sav").exists())
            assertArrayEquals(good, store.read("players/main/woody.sav.bak"))
            // a .bak is removed
            assertFalse(SaveDocuments.delete(store, "players/main/woody.sav.bak"))
            assertFalse(File(store.root, "players/main/woody.sav.bak").exists())
            for ((relative, expected) in listOf("players/main/none.sav" to SaveStore.Failure.NotFound, "players/../x" to SaveStore.Failure.InvalidPath)) {
                try {
                    SaveDocuments.delete(store, relative)
                    fail("expected $expected for $relative")
                } catch (failure: SaveStore.Failure) {
                    assertEquals(expected, failure)
                }
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun foldersAbove() {
        assertEquals(listOf("players/main", "players", ""), SaveDocuments.folderAndAbove("players/main"))
        assertEquals(listOf(""), SaveDocuments.folderAndAbove(""))
        assertEquals("players/main", SaveDocuments.parentOf("players/main/zezima.sav"))
        assertEquals("", SaveDocuments.parentOf("players"))
    }

    @Test
    fun notificationsAreThrottledPerFolder() {
        val scheduler = FakeScheduler()
        val sent = ArrayList<Pair<Long, String>>()
        val throttle = ChangeThrottle(scheduler, 2_000) { folder -> sent += scheduler.now() to folder }
        throttle.changed("bots/main")
        assertEquals(listOf(0L to "bots/main", 0L to "bots", 0L to ""), sent)
        sent.clear()
        // a burst within the interval: one notification each, at its end
        scheduler.advance(500)
        throttle.changed("bots/main")
        scheduler.advance(500)
        throttle.changed("bots/main")
        throttle.changed("players/main") // another folder: at once; the root is already waiting
        assertEquals(listOf(1_000L to "players/main", 1_000L to "players"), sent)
        sent.clear()
        scheduler.advance(1_000)
        assertEquals(setOf(2_000L to "bots/main", 2_000L to "bots", 2_000L to ""), sent.toSet())
        assertEquals(3, sent.size)
        sent.clear()
        // quiet for longer than the interval: at once again
        scheduler.advance(5_000)
        throttle.changed("players/main")
        assertEquals(listOf(7_000L to "players/main", 7_000L to "players", 7_000L to ""), sent)
        assertEquals(0, scheduler.pending)
    }
}
