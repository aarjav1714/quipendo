# Publishing Quipendo: start here

Everything that can be prepared without your accounts is done and tested: CI runs the extension in Chromium, Firefox and WebKit, lints the Firefox package, and converts and builds the Safari package on a macOS runner. Each store also needs your own developer account, a payment or identity check, and certifications only you can make, so those steps are yours.

1. **Get the packages.** Pushing a version tag (`git tag v0.1.0 && git push origin v0.1.0`; it must match `package.json`) makes the [Release workflow](../.github/workflows/release.yml) run every check and attach `quipendo-chrome-v0.1.0.zip`, `quipendo-firefox-v0.1.0.zip`, `quipendo-safari-v0.1.0.zip`, the source zip addons.mozilla.org asks for, and checksums to a [release](https://github.com/aarjav1714/quipendo/releases).
2. **Chrome Web Store**: [chrome-web-store.md](chrome-web-store.md). A developer account (one-time registration fee, 2-step verification, and a trader declaration where the store asks for one), then upload the zip, paste the listing, the privacy-tab answers and the test instructions, upload the five screenshots and the tiles, and submit.
3. **Firefox Add-ons**: [firefox-addons.md](firefox-addons.md). A free Mozilla account, then upload the zip and, when asked, the source zip with its build steps, fill in the listing, and paste the notes for reviewers.
4. **Safari**: [safari.md](safari.md). The Apple Developer Program (paid, yearly), then either App Store Connect's browser-based packager (no Mac or Xcode: upload the Safari zip) or Xcode, and submit through App Store Connect.
5. **Reviewers**: none of them has a Quip account, so each store's notes point at the built-in demo. [reviewing.md](reviewing.md) has the steps and the text to paste.

## Decide before the first submission

- **The name.** "Quip" is a Salesforce trademark and the name contains it ([the risk and the fallback](chrome-web-store.md#risks-to-know-about)).
- **The identifiers that cannot change afterwards.** The Firefox add-on id (`GECKO_ID` in `scripts/targets.mjs`) and the Apple bundle identifier (`io.github.aarjav1714.Quipendo`: it must end in the app name, see [safari.md](safari.md)) are permanent once a store has seen them.
- **Who the project is.** The licence, the package author, the add-on id and the bundle identifier name Aarjav (`aarjav1714`). The GitHub Sponsors links still point at another account (`.github/FUNDING.yml`, the README, `package.json`).
