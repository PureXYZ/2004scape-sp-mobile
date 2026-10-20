// lostcity.model: the bots' on-device chat model in an APK (docs/ANDROID.md §4). Applied by
// every module that makes an APK carrying the model: :app (its variants) and :llm (its instrumented tests' APK).
//
// - The model: android/build/model-assets/Model/{model.json, <the GGUF>}, which android/scripts/prepare-model.sh fills (the
//   iPhone's model by default), becomes the APK's assets/Model/. -Plc.model=none leaves it out (a quick build: Settings ›
//   Bot chat then says "Not in this build"); without a prepared model the build says so and goes on without one.
// - Stored, never deflated (noCompress "gguf"): LocalModel reads it straight from the APK by file descriptor at its offset,
//   with no copy and no second 529 MB on disk.
// - verifyModel: the GGUF's size and sha256 must be model.json's (cached by Gradle's input fingerprints: about 1 s when it
//   changed, nothing when not).
// - Aligned: llama.cpp mmaps the model from the APK only when its data sits at an offset 32 divides (the CPU buffers'
//   alignment), and AGP aligns stored entries to 4 bytes only. So every APK goes through `zipalign -P 16 32` (stored
//   entries to 32, native libraries to 16 KB pages), is signed again with the variant's own key (apksigner with
//   --alignment-preserved, which otherwise re-aligns everything to 4), and is checked: the build fails if the model is not
//   32-byte aligned. Without this the model still loads, read into memory instead (about 200 MB more; LocalModel's log line
//   says "read: not 32-byte aligned in the APK").
import com.android.build.api.artifact.ArtifactTransformationRequest
import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.dsl.ApkSigningConfig
import com.android.build.api.dsl.ApplicationVariantDimension
import com.android.build.api.dsl.CommonExtension
import com.android.build.api.dsl.LibraryVariantDimension
import com.android.build.api.variant.AndroidComponentsExtension
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.Component
import com.android.build.api.variant.LibraryAndroidComponentsExtension
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

class ModelPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.pluginManager.withPlugin("com.android.application") {
            configure(project, project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java))
        }
        project.pluginManager.withPlugin("com.android.library") {
            configure(project, project.extensions.getByType(LibraryAndroidComponentsExtension::class.java))
        }
    }

    private fun configure(project: Project, components: AndroidComponentsExtension<*, *, *>) {
        val android = project.extensions.getByType(CommonExtension::class.java)
        android.androidResources.noCompress.add("gguf")
        val modelRoot = File(project.rootDir, "build/model-assets")
        val modelJson = File(modelRoot, "Model/model.json")
        val wanted = project.providers.gradleProperty("lc.model").orNull != "none"
        val withModel = wanted && modelJson.isFile
        if (wanted && !modelJson.isFile) {
            project.logger.warn("lostcity.model: no model in $modelRoot (android/scripts/prepare-model.sh: the trained model from the cache, --download, or a <gguf>): the APK has none, and Bot chat says \"Not in this build\"")
        }

        val verify = project.tasks.register("verifyModel", VerifyModelTask::class.java) {
            group = "verification"
            description = "Checks the bundled chat model against its model.json (size and sha256)."
            modelDir.set(File(modelRoot, "Model"))
            stamp.set(project.layout.buildDirectory.file("model-verify/ok.txt"))
            onlyIf { withModel }
        }
        if (withModel) {
            project.tasks.configureEach {
                if (name.startsWith("merge") && name.endsWith("Assets")) dependsOn(verify)
            }
        }

        val sdk = components.sdkComponents.sdkDirectory
        val buildTools = android.buildToolsVersion
        fun prepare(component: Component, signing: ApkSigningConfig?) {
            if (withModel) component.sources.assets?.addStaticSourceDirectory(modelRoot.path)
            val name = "align${component.name.replaceFirstChar { it.uppercase() }}Apk"
            val task = project.tasks.register(name, AlignApkTask::class.java) {
                description = "zipalign -P 16 32 and re-sign the ${component.name} APK, so the chat model can be mmapped from it."
                zipalign.set(sdk.map { it.file("build-tools/$buildTools/zipalign").asFile.path })
                apksigner.set(sdk.map { it.file("build-tools/$buildTools/lib/apksigner.jar").asFile.path })
                val home = System.getProperty("user.home")
                storeFile.set(signing?.storeFile?.path ?: "$home/.android/debug.keystore")
                storePassword.set(signing?.storePassword ?: "android")
                keyAlias.set(signing?.keyAlias ?: "androiddebugkey")
                keyPassword.set(signing?.keyPassword ?: "android")
                requireModel.set(withModel)
            }
            val request = component.artifacts.use(task)
                .wiredWithDirectories(AlignApkTask::inputApks, AlignApkTask::outputApks)
                .toTransformMany(SingleArtifact.APK)
            task.configure { transformationRequest.set(request) }
        }

        when (components) {
            is ApplicationAndroidComponentsExtension -> components.onVariants { variant ->
                val buildType = android.buildTypes.getByName(variant.buildType ?: "debug") as ApplicationVariantDimension
                prepare(variant, buildType.signingConfig ?: android.signingConfigs.findByName("debug"))
            }
            is LibraryAndroidComponentsExtension -> components.onVariants { variant ->
                val buildType = android.buildTypes.getByName(variant.buildType ?: "debug") as LibraryVariantDimension
                for (test in variant.deviceTests.values) {
                    prepare(test, buildType.signingConfig ?: android.signingConfigs.findByName("debug"))
                }
            }
            else -> Unit
        }
    }
}

/** The GGUF's size and sha256 against model.json's (prepare-model.sh wrote both; a stale copy would load the wrong model). */
abstract class VerifyModelTask : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val modelDir: DirectoryProperty

    @get:OutputFile
    abstract val stamp: RegularFileProperty

    @TaskAction
    fun verify() {
        val dir = modelDir.get().asFile
        val json = File(dir, "model.json").readText()
        fun field(name: String): String? = Regex("\"$name\"\\s*:\\s*\"?([^\",}]*)\"?").find(json)?.groupValues?.get(1)?.trim()
        val file = File(dir, field("file") ?: throw GradleException("lostcity.model: $dir/model.json names no file"))
        if (!file.isFile) throw GradleException("lostcity.model: $file is missing (android/scripts/prepare-model.sh)")
        val bytes = field("bytes")?.toLongOrNull()
        if (bytes != null && bytes != file.length()) {
            throw GradleException("lostcity.model: $file is ${file.length()} bytes, model.json says $bytes (android/scripts/prepare-model.sh again)")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered(1 shl 20).use { input ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        val expected = field("sha256")
        if (!expected.isNullOrEmpty() && expected != sha) {
            throw GradleException("lostcity.model: $file has sha256 $sha, model.json says $expected (android/scripts/prepare-model.sh again)")
        }
        stamp.get().asFile.apply { parentFile.mkdirs() }.writeText("${file.name} ${file.length()} $sha\n")
        logger.lifecycle("lostcity.model: ${file.name} (${file.length() / 1_048_576} MB) matches model.json")
    }
}

/**
 * The APK transform: zipalign 32 (16 KB pages for native libraries), apksigner with the variant's key, then a check that
 * every stored entry is aligned (the model's offset is printed). AGP installs and tests the APK this writes.
 */
abstract class AlignApkTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val inputApks: DirectoryProperty

    @get:OutputDirectory
    abstract val outputApks: DirectoryProperty

    @get:Internal
    abstract val transformationRequest: Property<ArtifactTransformationRequest<AlignApkTask>>

    @get:Input abstract val zipalign: Property<String>
    @get:Input abstract val apksigner: Property<String>
    @get:Input abstract val storeFile: Property<String>
    @get:Internal abstract val storePassword: Property<String>
    @get:Input abstract val keyAlias: Property<String>
    @get:Internal abstract val keyPassword: Property<String>
    @get:Input abstract val requireModel: Property<Boolean>

    @TaskAction
    fun align() {
        transformationRequest.get().submit(this) { artifact ->
            val input = File(artifact.outputFile)
            val output = outputApks.get().file(input.name).asFile
            val aligned = File(temporaryDir, input.name)
            run(listOf(zipalign.get(), "-f", "-P", "16", "32", input.path, aligned.path))
            val java = File(System.getProperty("java.home"), "bin/java").path
            run(
                listOf(java, "-jar", apksigner.get(), "sign", "--ks", storeFile.get(), "--ks-pass", "env:LC_KS_PASS",
                    "--key-pass", "env:LC_KEY_PASS", "--ks-key-alias", keyAlias.get(), "--alignment-preserved", "true",
                    "--out", output.path, aligned.path),
                mapOf("LC_KS_PASS" to storePassword.get(), "LC_KEY_PASS" to keyPassword.get()),
            )
            aligned.delete()
            File(output.path + ".idsig").delete()
            val report = ApkAlignment.check(output)
            if (report.misaligned.isNotEmpty()) {
                throw GradleException("lostcity.model: ${output.name} has stored entries off their alignment: ${report.misaligned.take(5)}")
            }
            val model = report.model
            when {
                model != null -> logger.lifecycle("lostcity.model: ${output.name}: ${model.first} at offset ${model.second} (mod 32 = ${model.second % 32}): mmap from the APK")
                requireModel.get() -> throw GradleException("lostcity.model: ${output.name} has no stored assets/Model/*.gguf")
                else -> logger.lifecycle("lostcity.model: ${output.name}: aligned (no model in it)")
            }
            output
        }
    }

    private fun run(command: List<String>, environment: Map<String, String> = emptyMap()) {
        val process = ProcessBuilder(command).redirectErrorStream(true).apply { environment().putAll(environment) }.start()
        val text = process.inputStream.bufferedReader().readText()
        if (process.waitFor() != 0) {
            throw GradleException("lostcity.model: ${File(command.first()).name} ${command.drop(1).firstOrNull() ?: ""} failed: $text")
        }
    }
}

/** Where each stored entry's data starts in an APK (the zip's local headers), as zipalign -c checks it. */
object ApkAlignment {
    class Report(val misaligned: List<String>, val model: Pair<String, Long>?)

    fun check(apk: File): Report {
        RandomAccessFile(apk, "r").use { file ->
            val length = file.length()
            // the end of central directory record, in the last 64 KB + 22 bytes
            val tail = ByteArray(minOf(length, 65_557L).toInt())
            file.seek(length - tail.size)
            file.readFully(tail)
            var eocd = -1
            for (i in tail.size - 22 downTo 0) {
                if (u32(tail, i) == 0x06054b50L) {
                    eocd = i
                    break
                }
            }
            if (eocd < 0) throw GradleException("lostcity.model: $apk is not a zip")
            val entries = u16(tail, eocd + 10)
            val cdOffset = u32(tail, eocd + 16)
            val cdSize = u32(tail, eocd + 12)
            val cd = ByteArray(cdSize.toInt())
            file.seek(cdOffset)
            file.readFully(cd)
            val misaligned = mutableListOf<String>()
            var model: Pair<String, Long>? = null
            var at = 0
            val local = ByteArray(30)
            repeat(entries) {
                val method = u16(cd, at + 10)
                val nameLength = u16(cd, at + 28)
                val extraLength = u16(cd, at + 30)
                val commentLength = u16(cd, at + 32)
                val headerOffset = u32(cd, at + 42)
                val name = String(cd, at + 46, nameLength, Charsets.UTF_8)
                at += 46 + nameLength + extraLength + commentLength
                if (method != 0) return@repeat
                file.seek(headerOffset)
                file.readFully(local)
                val data = headerOffset + 30 + u16(local, 26) + u16(local, 28)
                val alignment = if (name.endsWith(".so")) 16_384 else 32
                if (data % alignment != 0L) misaligned += "$name@$data"
                if (name.startsWith("assets/Model/") && name.endsWith(".gguf")) model = name to data
            }
            return Report(misaligned, model)
        }
    }

    private fun u16(bytes: ByteArray, at: Int): Int = (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)

    private fun u32(bytes: ByteArray, at: Int): Long = (u16(bytes, at).toLong()) or (u16(bytes, at + 2).toLong() shl 16)
}
