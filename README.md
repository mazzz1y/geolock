# GeoLock

<p align="center">
  <img src=".github/logo.png" width="96" height="96" alt="GeoLock Logo">
</p>

GeoLock is a Firefox extension that blocks or allows sub-resource requests with per-page rules using v2fly geoip/geosite, domain regex, and IP range matchers.

[<img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg"
alt="Get it on Firefox Add-ons"
height="54">](https://addons.mozilla.org/firefox/addon/84ec3815000144658945/)


## Features

You write rules that combine a **website** (the page the user is on) with a **resource** (what that page is loading), and decide whether to allow or block.

![GeoLock options page](.github/screenshot.png)

- Per-website rules: match on both the page and the resource it loads
- Matcher types: geosite category, geoip country, domain regex, IP CIDR, composites (`all_of`, `any_of`, `not`)
- Bidirectional rules, fire in both website↔resource directions
- v2fly geoip.dat and geosite.dat support
- Remote configuration
- In-memory LRU DNS cache
- Built-in tester
- Raw JSON editor, import/export, and one-click reset

**Example rules:**
- Block any cross-border resource: when on a US site, block non-US IP.
- Allow only known CDNs when browsing a sensitive site.

## What it does

Every sub-resource request a page makes (images, scripts, API calls, fonts, etc.) is evaluated against your rules in order. The first rule that matches decides the outcome. If no rule matches, the configured default action applies.

**A rule has two sides and an action:**
- **Website matcher** — describes the page the user is on.
- **Resource matcher** — describes what that page is trying to load.
- **Action** — `allow` or `block`.

Both sides must match for the rule to fire. Rules can also be made **bidirectional**: they match even when the website and resource roles are swapped.

**Matcher types:**
- `geosite` — matches a v2fly geosite category (e.g. `google`, `category-ads-all`). Optionally scoped to an attribute (e.g. `google@ads` for Google's Ads domains).
- `geoip` — matches by the resolved IP country using v2fly geoip data.
- `domain` — matches the hostname against a regular expression.
- `ip` — matches the resolved IP against a CIDR range (IPv4 or IPv6).
- `any` — always matches.
- `all_of`, `any_of`, `not` — compose the above.

## Known issues

### Firefox-only

GeoLock uses blocking `webRequest`, which Chrome MV3 makes unavailable to extensions distributed through the Chrome Web Store (only enterprise policy-installed extensions retain webRequestBlocking). Geoip and CIDR matching require the resolved destination IP, which declarativeNetRequest does not expose in any rule condition. 

**So the extension targets Firefox 142+ and is not portable to Chromium at that moment**

### Disclaimer

This extension is experimental and should be treated as a PoC. It may contain bugs, architectural flaws, or security issues

## License

[MIT](LICENSE)
