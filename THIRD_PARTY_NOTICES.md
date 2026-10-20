# Third-party notices

2004Scape's own code is MIT licensed, Copyright (c) 2026 PureXYZ (see [LICENSE](LICENSE)). That licence covers only
the code written for this project. The third-party parts below keep their own licences and copyright notices. The
RuneScape game data, and the files in this repository that show Jagex's art (the app icon and the README's
screenshots), are not covered by any of them (section C).

2004Scape is a derived work: the game it runs is Lost City's (section A), and its bots are a port of 2004SP
Progressive's bot AI (section B). Most of the code written for this project was generated with Claude (Anthropic),
through Claude Code.

The apps carry this file and LICENSE as `licenses.txt` (built by `scripts/build-web.mjs` into `build/Game`, the folder
both apps ship). In the app it is under **Settings › About › Licences**. The full text of each licence is at the end of
this file, in [Licence texts](#licence-texts).

> 2004Scape is an unofficial fan project. It is not affiliated with, endorsed by or connected to Jagex Ltd or the Lost
> City project. RuneScape is a registered trademark of Jagex Ltd. The game data the app is built from is the
> intellectual property of Jagex Ltd. This project is free: no ads, no payments, no accounts.

## Contents

- [A. Lost City](#a-lost-city)
- [B. 2004SP Progressive (the bots' AI)](#b-2004sp-progressive-the-bots-ai)
- [C. RuneScape game data (Jagex Ltd)](#c-runescape-game-data-jagex-ltd)
- [D. llama.cpp and ggml](#d-llamacpp-and-ggml)
- [E. The on-device chat model (Qwen3.5-0.8B)](#e-the-on-device-chat-model-qwen35-08b)
- [F. Libraries inside the game bundle](#f-libraries-inside-the-game-bundle)
- [G. Soundfont](#g-soundfont)
- [H. Android app libraries](#h-android-app-libraries)
- [I. Period sources](#i-period-sources)
- [J. Build and training tools (not shipped)](#j-build-and-training-tools-not-shipped)
- [Licence texts](#licence-texts)

## A. Lost City

[Lost City](https://github.com/LostCityRS) is an open-source reimplementation of RuneScape as it was in 2004. 2004Scape
is built from its revision-274 sources, at the commits pinned in `upstream.json`. The repository contains none of their
code except the changes listed here; the build fetches the sources (`scripts/fetch-upstream.mjs`).

| Component | Commit | Licence | Copyright | How 2004Scape uses it |
|---|---|---|---|---|
| [Engine-TS](https://github.com/LostCityRS/Engine-TS) (branch 274) | `1d25566c` | MIT | Copyright (c) 2023-2026 Lost City | Bundled into the engine worker (`engine/engine.js`, `engine/engine-bots.js`). Node.js modules are replaced by browser shims and a few engine modules by the port's own (`web/engine/src/shims`); the engine's sources are not edited. Its packer builds the game cache and the server data the apps ship. |
| [Content](https://github.com/LostCityRS/Content) (branch 274) | `65b754f7` | MIT (source code only) | Copyright (c) 2023-2026 Lost City | Its scripts and configs are compiled into the shipped server data. Three scripts are changed for the bots by a patch overlay (`web/engine/bots/content`). Its assets are Jagex's (section C). |
| [Client-TS](https://github.com/LostCityRS/Client-TS) (branch 274) | `7d6ca61a` | MIT | Copyright (c) 2023-2026 Lost City | Built into `client/client.js` and `client/mapview.js` with a patch series (`web/client/patches`) and whole-module replacements (`web/client/overrides`), both derived from Client-TS. |
| [Server](https://github.com/LostCityRS/Server) | any | MIT | Copyright (c) 2025-2026 Lost City | Not shipped. A Server checkout beside this repository is one place the build can find the three sources above. |

Content's README: "Assets within are the intellectual property of Jagex Ltd. These do not get covered by our software
license. They were originally obtained from their official software distribution channels then extracted here, and are
included for historical preservation."

Engine-TS's `src/util/QuickSort.ts`, bundled into the engine worker with the rest of Engine-TS, is a quicksort that
matches the game's own ordering. Its header credits the original to **Cook**
(https://runescape.wiki/w/MediaWiki:Gadget-perkcalc-core.js) and the translation into JavaScript to **Keyboard**
(https://github.com/qwertypedia/qwertypedia.github.io, `killcreditcalc.js`). The wiki publishes its pages under its
own content licence (CC BY-NC-SA 3.0); the qwertypedia repository states no licence. 2004Scape takes the file, unchanged,
as part of Engine-TS.

`web/engine/bots/test/ref/Inventory254.ts` (a test reference, not shipped) is Engine-TS's revision-254
`src/engine/Inventory.ts`, MIT, Copyright (c) 2023-2026 Lost City.

## B. 2004SP Progressive (the bots' AI)

The bots run the AI of [2004SP Progressive](https://github.com/2004sp/2004sp-progressive) (Lost City Singleplayer
Progressive), by **attackishere** (lead developer), **_mrsam** (trading, bot AI), **K-andy** (bot phrases) and
**Callum** (node switch), with its other contributors. Its bot folder and two phrase files are vendored from commit
`aeadbc43114d70805dd16a98bf327439732d535a` (2026-09-27) into `web/engine/bots` and ported from revision 254 to 274; each
change is marked `port:` in the source. `web/engine/bots/UPSTREAM` lists the files, and `web/engine/bots/LICENSE` is the
notice that goes with them. They are bundled into `engine/engine-bots.js` and `engine/vfs/bots`.

Licence: MIT, Copyright (c) 2026 2004SP Progressive contributors (attackishere, _mrsam, K-andy, Callum). The port's
changes are Copyright (c) 2026 PureXYZ, also MIT. Upstream has no LICENSE file. Its authors grant the licence in these
two statements, and Lost City's licence is MIT:

- Its README (https://github.com/2004sp/2004sp-progressive, "License"): "This
  project is fully open source and available under the same license as Lost City (see LICENSE file)."
- Its credits page (https://www.2004sp.cc/content/credits.md): "All code in this
  project is open source under the same licence as Lost City."

2004SP Progressive calls itself a spiritual successor to EasyRS2 / RS2 Progressive by **mige**. No code from that
project is used here; it is credited for the idea of a single-player world of progressing bots.

## C. RuneScape game data (Jagex Ltd)

The apps ship RuneScape revision 274's game data, built from Lost City's Content repository: the game cache, maps,
models, textures, sprites, interfaces, fonts, music, sound effects and text. The HUD's fonts are converted from the
game's own bitmap fonts and its icons are the game's sprites (`web/ui` converts them when the app is built). All of
this is the intellectual property of Jagex Ltd. It is not covered by this project's licence or by Lost City's. The
repository does not contain the game data: the build takes it from Lost City's Content repository.

The repository does contain these files, which show Jagex's art. They are the intellectual property of Jagex Ltd, the
MIT licence in [LICENSE](LICENSE) does not cover them, and no licence to them is given here:

- The app icon, the "RS" rune stones of the 2004 RuneScape logo, which both apps ship: `ios/Config/AppIcon-source.png`;
  `ios/LostCity/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, `AppIcon-Dark.png` and `AppIcon-Tinted.png`;
  `android/app/src/main/res/mipmap-*/ic_launcher_background.png`, `ic_launcher_foreground.png` and
  `ic_launcher_monochrome.png` (five densities); `android/store/icon-512.png`. (The scripts that make the icon sizes,
  `ios/scripts/make-icon.swift` and `android/scripts/make-icon.swift`, are this project's code.)
- The screenshots of the game in `docs/images` (`world.png`, `panel.png`, `bots.png`, `android.png`).

2004Scape is an unofficial fan project. It is not affiliated with, endorsed by or connected to Jagex Ltd or the Lost
City project. RuneScape is a registered trademark of Jagex Ltd. The game data the app is built from is the
intellectual property of Jagex Ltd. This project is free: no ads, no payments, no accounts.

## D. llama.cpp and ggml

The on-device chat model runs on [llama.cpp](https://github.com/ggml-org/llama.cpp) release `b11297`: its prebuilt
`llama.xcframework` in the iPhone app and its prebuilt Android libraries (`libllama.so`, `libggml.so`,
`libggml-base.so` and the `libggml-cpu-android_*.so` CPU variants) in the Android app.

- llama.cpp and ggml: MIT, Copyright (c) 2023-2026 The ggml authors.
- The llamafile matrix kernels inside ggml's CPU backend (`ggml/src/ggml-cpu/llamafile/sgemm.cpp`, in both apps'
  binaries): MIT, Copyright 2024 Mozilla Foundation.
- The YaRN rotary-embedding code in ggml's CPU and Metal backends (`ggml/src/ggml-cpu/ops.cpp`,
  `ggml/src/ggml-metal/kernels/rope.metal`; the CPU code is in both apps' binaries, the Metal source in the iPhone app's
  `llama.framework`): MIT, Copyright (c) 2023 Jeffrey Quesnelle and Bowen Peng.

The shipped binaries do not include ggml's optional Arm KleidiAI kernels.

## E. The on-device chat model (Qwen3.5-0.8B)

The full apps ship `bots-2004-q4km.gguf`, which is also attached on its own to the GitHub release `model-v1` and to
each release `v<version>`, with `licenses.txt` (this file and LICENSE, with the licence texts). It is a
modified version of [Qwen/Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B) (revision
`2fc06364715b967f1860aea9cf38778875588b17`), licensed under the Apache License 2.0, Copyright 2026 Alibaba Cloud.
The Qwen repository has no NOTICE file.

Modification notice (Apache License 2.0, section 4(b)): this model was changed from the original for this project in 2026. A
LoRA (rank 16) was fine-tuned on game chat lines, merged into the base weights, converted to GGUF with llama.cpp
`b11297` and quantised to Q4_K_M with an importance matrix from the training text. The model is distributed under the
Apache License 2.0; the GGUF's metadata names that licence. Its metadata also names "Qwen3.5 0.8B Base"
(Qwen/Qwen3.5-0.8B-Base) as the base model: llama.cpp's converter copied that from the Qwen3.5-0.8B model card. The
weights it was made from are Qwen/Qwen3.5-0.8B's, at the revision above; a model built after this one names that
base model in its metadata, with this notice as its description (`web/engine/bots/test/model-data/gguf-metadata.json`).

The fine-tune's training replies were written with Claude (Anthropic) to a brief, for game situations made by the
port's own simulator. The bots' corpus of late-2004 lines (`web/engine/bots/data/lines2004*.json`) was written with
Claude in the same way. Both are written in the style of the period; neither quotes third-party text. The training
code is in `web/engine/bots/test/model-data`; the training data is not published.

## F. Libraries inside the game bundle

These are compiled into the web bundle (`build/Game`) that both apps ship.

| Library | Version | Licence | Copyright | Where |
|---|---|---|---|---|
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett | engine worker, client |
| [kleur](https://github.com/lukeed/kleur) | 4.1.5 | MIT | Copyright (c) Luke Edwards (lukeed.com) | engine worker (Engine-TS's logging) |
| [@isaacs/ttlcache](https://github.com/isaacs/ttlcache) | 2.1.5 | BlueOak-1.0.0 | Isaac Z. Schlueter | engine worker |
| [bz2](https://github.com/SheetJS/bz2) (SheetJS), in Client-TS `src/io/BZip2.js` | as in Client-TS | MIT | Copyright 2019 SheetJS LLC | client, world map |
| [java-random](https://github.com/raybellis/java-random), adapted in Lost City's `src/util/JavaRandom.ts` | as in Lost City | ISC | Copyright (c) Ray Bellis | engine worker, client, world map |
| [tinymidipcm](https://github.com/misterhat/tinymidipcm) (music synthesis: `client/tinymidipcm.wasm` and its loader) | as in Client-TS | MIT | Copyright (c) Zorian Medwid (misterhat) | client |
| [TinySoundFont](https://github.com/schellingb/TinySoundFont) `tsf.h`, inside tinymidipcm | as in tinymidipcm | MIT | Copyright (C) 2017, 2018 Bernhard Schelling; based on SFZero, Copyright (C) 2012 Steve Folta | client |
| TinyMidiLoader `tml.h` (part of TinySoundFont), inside tinymidipcm | as in tinymidipcm | zlib | Copyright (C) 2017, 2018, 2020 Bernhard Schelling | client |
| [Fix iOS AudioContext](https://gist.github.com/kus/3f01d60569eeadefe3a1), in Client-TS `src/3rdparty/audio.js` | as in Client-TS | MIT | Copyright (c) Blake Kus | client |
| [bzip2 / libbzip2](https://sourceware.org/bzip2/) 1.0.8, as WebAssembly (`engine/bzip2.wasm`, Engine-TS's build via [bzip2-wasm](https://github.com/misterhat/bzip2-wasm)) | 1.0.8 | bzip2 licence | Copyright (C) 1996-2019 Julian R Seward | engine worker |
| bzip2 / libbzip2 1.0.8's decoder, ported to TypeScript (`web/engine/src/shims/bunzip2.ts`) | 1.0.8 | bzip2 licence | Copyright (C) 1996-2019 Julian R Seward | engine worker |

The TypeScript port of the bzip2 decoder is an altered version of libbzip2's `decompress.c` and `bzlib.c`: it decodes
only, rejects randomised blocks and is written in TypeScript. It is not the original software.

The engine's use of [node-forge](https://github.com/digitalbazaar/forge) is replaced by the port's own
`web/engine/src/shims/forge-lite.ts`, so no node-forge code is in the apps (section J).

## G. Soundfont

`client/SCC1_Florestan.sf2`, the instruments the music is played with, is redistributed from Lost City Engine-TS
(`public/client`). Its metadata names it "Florestan Basic GM GS", by Nando Florestan (http://go.to/florestan), and
gives its copyright as "Public Domain".

## H. Android app libraries

The Android app is built with these libraries from Google's Maven repository and Maven Central. All are licensed under
the Apache License 2.0.

- AndroidX: core, core-ktx, activity, webkit, annotation, annotation-experimental, collection, arch core, lifecycle,
  savedstate, concurrent-futures, interpolator, navigationevent, profileinstaller, startup, tracing,
  versionedparcelable and compose runtime-annotation. Copyright The Android Open Source Project.
- Kotlin standard library 2.2.10. Copyright JetBrains s.r.o. and Kotlin Programming Language contributors.
- kotlinx.serialization (core, json) 1.9.0 and kotlinx.coroutines 1.9.0. Copyright JetBrains s.r.o. and contributors.
- JetBrains Java Annotations. Copyright JetBrains s.r.o.
- Guava ListenableFuture 1.0. Copyright The Guava Authors.
- JSpecify 1.0.0. Copyright The JSpecify Authors.

The iPhone app uses only Apple's system frameworks and llama.cpp (section D); it has no Swift packages.

## I. Period sources

The bots' street prices, rares and some of their talk follow what players wrote in late 2004, as preserved by the
Internet Archive. The facts come from these sites; no text is copied from them:

- RuneHQ (its item database's street prices, December 2004)
- Sal's Realm of RuneScape (player tips and its November 2004 Q&A)
- Tip.it
- PCGamesN (a retrospective on party hat prices)

## J. Build and training tools (not shipped)

These are used to build the apps or the model. None of their code is in the apps.

| Tool | Licence | Use |
|---|---|---|
| [esbuild](https://github.com/evanw/esbuild) 0.28.0 | MIT | bundles the web code |
| [node-forge](https://github.com/digitalbazaar/forge) 1.4.0 | BSD-3-Clause OR GPL-2.0 | reads the RSA key when the client is built (`web/client/build.mjs`) |
| Lost City Engine-TS's packer and script compiler | MIT | build the game data from Content |
| Gradle, the Gradle wrapper, the Android Gradle Plugin, the Kotlin compiler | Apache-2.0 | build the Android app |
| Xcode and the iOS SDK | Apple's terms | build the iPhone app |
| [mlx-lm](https://github.com/ml-explore/mlx-lm) 0.32.0, MLX | MIT | trains the LoRA (`web/engine/bots/test/model-data`; `gdn_chunked.py` follows the chunked gated delta rule as Hugging Face transformers writes it, Apache-2.0) |
| llama.cpp `b11297`'s `convert_hf_to_gguf.py`, `llama-imatrix`, `llama-quantize` | MIT | convert and quantise the model |
| [unsloth/Qwen3.5-0.8B-GGUF](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF) | Apache-2.0 | the unmodified base model, for comparisons (`prepare-model.sh --spike`); not in a release |

## Licence texts

Each licence's full text, once. The copyright lines that go with each are in the sections above.

### MIT License

Used by: 2004Scape itself, Lost City (Engine-TS, Content's source code, Client-TS, Server), 2004SP Progressive,
llama.cpp and ggml, llamafile's sgemm, ggml's YaRN code, fflate, kleur, SheetJS bz2, tinymidipcm, TinySoundFont, Fix
iOS AudioContext.

```text
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0

Used by: Qwen3.5-0.8B and the chat model made from it, the Android app libraries (section H).

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### ISC License

Used by: java-random.

```text
ISC License

Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Blue Oak Model License 1.0.0

Used by: @isaacs/ttlcache. Also at https://blueoakcouncil.org/license/1.0.0.

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

### bzip2 licence

Used by: bzip2 / libbzip2 1.0.8 (the WebAssembly build and the TypeScript port of its decoder).

```text
This program, "bzip2", the associated library "libbzip2", and all
documentation, are copyright (C) 1996-2019 Julian R Seward.  All
rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. The origin of this software must not be misrepresented; you must
   not claim that you wrote the original software.  If you use this
   software in a product, an acknowledgment in the product
   documentation would be appreciated but is not required.

3. Altered source versions must be plainly marked as such, and must
   not be misrepresented as being the original software.

4. The name of the author may not be used to endorse or promote
   products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS
OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Julian Seward, jseward@acm.org
bzip2/libbzip2 version 1.0.8 of 13 July 2019
```

### zlib License

Used by: TinyMidiLoader (inside tinymidipcm).

```text
This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```
