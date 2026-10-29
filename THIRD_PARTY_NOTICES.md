# Third-party software and visual assets

Whale Pet is an independent project. It is not an official OpenAI or DeepSeek application, and those organizations do not own or endorse this project's name or character. References to providers describe compatibility. Their names and trademarks remain with their respective owners.

Project-authored source code is distributed under the MIT License in `LICENSE`. That license does not replace the licenses of bundled third-party software.

## Node.js

The backend uses Node.js. The Node.js project distributes its own code under the MIT license and includes externally maintained components under additional licenses. A binary release that bundles Node.js must include the **complete LICENSE file from that exact Node.js version**, including the component notices, rather than a shortened MIT notice.

Official source: [Node.js LICENSE](https://github.com/nodejs/node/blob/main/LICENSE). The exact bundled version, upstream download source and SHA-256 should be recorded in the release manifest. Preserve the upstream license and notices in the app's license resources and release archive.

## OpenAI Codex CLI

Releases that include Codex CLI must preserve its Apache-2.0 `LICENSE`, its `NOTICE`, and the notices required for dependencies distributed in that binary. The upstream NOTICE includes attribution for code derived from Ratatui. Codex is optional runtime software; including it does not authorize using someone else's account or imply an affiliation with OpenAI.

Official sources: [Codex LICENSE](https://github.com/openai/codex/blob/main/LICENSE), [Codex NOTICE](https://github.com/openai/codex/blob/main/NOTICE), and [official package metadata](https://github.com/openai/codex/blob/main/codex-cli/package.json). Obtain the license and notices for the **exact pinned release** that is packaged, and record its version, upstream source and SHA-256 in the release manifest. A citation to the current main branch is explanatory and is not a substitute for the corresponding bundled files.

## Character images and animation sheets

The character artwork and animation atlases included in `assets/` were generated with AI for this desktop companion. The repository includes the generation prompts and animation region manifests that are useful for maintenance. Private generation identifiers, session links and paths to original tool output are excluded.

To the extent the contributors hold rights in these supplied images, they permit their use, modification and redistribution under this project's MIT License. This statement does not guarantee that AI-generated material is copyrightable in every jurisdiction, grant rights in third-party characters or trademarks, or certify that no similar image exists. The assets are not official OpenAI or DeepSeek brand artwork. Redistributors should not present the character or application as endorsed by either company.

## macOS frameworks

The native application uses system-provided Apple frameworks. Those frameworks are supplied by macOS and are not copied into this source repository. Building and running the application requires a compatible macOS system and the applicable Apple developer tools.

## Windows .NET runtime and installer

The Windows native interface uses WPF and Windows Forms with the Microsoft .NET runtime pinned in `windows-runtime-lock.json`. Self-contained releases preserve the LICENSE and available THIRD-PARTY-NOTICES from the exact restored `Microsoft.NETCore.App.Runtime.win-x64` and `Microsoft.WindowsDesktop.App.Runtime.win-x64` packages under `licenses/`. Those upstream notices govern the redistributed runtime components; the project MIT license does not replace them.

The Windows installer is built with Inno Setup 6.7.4 from its official release, with the tool download SHA-256 pinned in `windows-runtime-lock.json`. Its original license is preserved in the application distribution. The source file `windows/ChineseSimplified.isl` comes from the same upstream release's `Files/Languages/Unofficial/ChineseSimplified.isl`; its translator attribution remains intact. It is a third-party translation, not a project contributor's personal contact. See [Inno Setup source](https://github.com/jrsoftware/issrc/tree/is-6_7_4) for the original files.

## Release verification

Source-only checkouts do not redistribute the Node.js or Codex executables merely by mentioning them. Binary release publishers must verify the actual packaged runtimes, complete license and notice files, and release manifest before publishing. This notice is an attribution guide; the upstream license texts distributed with each component determine its terms.
