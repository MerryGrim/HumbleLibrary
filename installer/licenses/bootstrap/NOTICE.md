# Installer bootstrap notices

The language-selector bootstrap uses the same Mira Mint Win32 implementation as
the MiraLabel installer, adapted for Humble Library and all nine application
languages. The original component MIT notice is preserved in `MiraMint-MIT.txt`
and embedded in every language's license agreement.

The bootstrap is compiled with MSVC `/MT`. The Microsoft STL Apache-2.0 license
with LLVM exception is preserved in `Microsoft-STL-LICENSE.txt` and embedded in
the installer agreements. Microsoft Windows SDK libraries and static CRT
redistribution are governed by the installed Visual Studio / Build Tools license;
that permission is not replaced or granted by the application's MIT license.

The compiler path and SHA-256 are recorded for each actual bootstrap build. This
notice is not an Authenticode signature or proof of execution on a clean machine.
