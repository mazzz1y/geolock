# GeoLock

<p align="center">
  <img src=".github/logo.png" width="96" height="96" alt="GeoLock Logo">
</p>

GeoLock is a Firefox extension that blocks or allows sub-resource requests with per-page rules using v2fly geoip/geosite, domain regex, and IP range matchers.

[<img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg"
alt="Get it on Firefox Add-ons"
height="54">](https://addons.mozilla.org/firefox/addon/84ec3815000144658945/)


## Features

You write rules that combine a **source** (the page making the request) with a **destination** (what that page is loading), and decide whether to allow or block.

![GeoLock options page](.github/screenshot.png)

- Per-page rules: match on both the source and the destination it loads
- Matcher types: geosite category, geoip country, domain regex, IP CIDR, composites (`and`, `or`, `not`)
- Bidirectional rules, fire in both source↔destination directions
- Isolate rules: fire when traffic crosses a boundary (source XOR destination is in a set)
- v2fly geoip.dat and geosite.dat support
- Remote configuration
- In-memory LRU DNS cache
- Built-in tester
- Raw JSON editor, import/export, and one-click reset

**Example rules:**
- Block any cross-border resource: when on a US site, block non-US IP.
- Allow only known CDNs when browsing a sensitive site.
- Block any cross-US traffic in either direction with one isolate rule.

## How it works

Every time a page loads something — an image, a script, a tracking pixel, an API call — GeoLock checks your rules and decides whether to let it through or stop it.

Each rule answers two questions: **which page is making the request?** and **where is the request going?** If both sides match what you described, the rule fires and applies its action (allow or block). If no rule matches, GeoLock falls back to your default action.

Rules can be **bidirectional**, meaning they fire whether the page-and-resource pair appears in the order you wrote it or the reverse. Useful for symmetric "no traffic between X and Y" policies.

There are also **isolate rules** for a common pattern: keep two worlds apart. You define a single boundary (say, "anything in the US"), and the rule fires whenever traffic crosses it — exactly one side of the request is inside, the other is outside. One short rule replaces two bidirectional rules with NOT.

To describe the originating page or the request target, you pick a **matcher**:
- match by country (resolved IP geolocation)
- match by category (v2fly geosite tags like `google`, `category-ads-all`)
- match by domain pattern (regex against the hostname)
- match by URL pattern (regex against the full URL)
- match by IP range (CIDR, IPv4 or IPv6)
- match anything
- combine the above with **and**, **or**, **not**

Rules are evaluated in order, top to bottom. The first one that matches wins — so put your specific exceptions above your broad blocks.

## Configuration

The actual config schema is documented in [`docs/config/v2.md`](docs/config/v2.md).

Legacy v1 configs (shipped through GeoLock 1.4.x) are documented in [`docs/config/v1.md`](docs/config/v1.md) and are migrated to v2 automatically on extension start and on import.

## Known issues

### Firefox-only

GeoLock uses blocking `webRequest`, which Chrome MV3 makes unavailable to extensions distributed through the Chrome Web Store (only enterprise policy-installed extensions retain webRequestBlocking). Geoip and CIDR matching require the resolved destination IP, which declarativeNetRequest does not expose in any rule condition. 

**So the extension targets Firefox 142+ and is not portable to Chromium at that moment**

### Disclaimer

This extension is experimental and should be treated as a PoC. It may contain bugs, architectural flaws, or security issues

## License

[MIT](LICENSE)
