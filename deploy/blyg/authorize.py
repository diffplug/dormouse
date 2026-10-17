#!/usr/bin/env python3
"""Renew Studio publishing access without writing credentials to disk or argv."""
import argparse
import datetime
import getpass
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = "https://blyg.dormouse.sh"
NAME = "Dormouse release publisher"
ROOT = Path(__file__).resolve().parents[2]


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl)[:2] != urllib.parse.urlsplit(ORIGIN)[:2]:
            raise RuntimeError("Refusing cross-origin Studio redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initialize", action="store_true", help="Set a NEW installation's owner password in Cloudflare first")
    parser.add_argument("--publish", action="store_true", help="Sync released changelog entries after renewing access")
    args = parser.parse_args()
    password = getpass.getpass("Choose the new Dormouse Studio owner password: " if args.initialize else "Dormouse Studio owner password: ")
    if not password:
        raise RuntimeError("Password must not be empty")
    if args.initialize:
        if len(password) < 16:
            raise RuntimeError("Use an owner password with at least 16 characters")
        if password != getpass.getpass("Confirm owner password: "):
            raise RuntimeError("Passwords did not match")
        release = json.loads((ROOT / "deploy/blyg/release.json").read_text())
        # Run outside the monorepo: npm does not understand pnpm's devEngines onFail=download.
        with tempfile.TemporaryDirectory(prefix="dormouse-blyg-auth-") as cwd:
            subprocess.run(["npx", "--yes", f"wrangler@{release['wranglerVersion']}", "secret", "put", "OWNER_PASSWORD", "--config", str(ROOT / "deploy/blyg/wrangler.jsonc")], input=password, text=True, cwd=cwd, check=True)

    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), SameOriginRedirect())
    # Cloudflare Browser Integrity Check rejects urllib's generic default UA.
    client.addheaders = [("User-Agent", "dormouse-blyg-publisher/1.0 (+https://dormouse.sh)")]
    login = urllib.request.Request(ORIGIN + "/studio/login", data=urllib.parse.urlencode({"password": password}).encode(), headers={"Origin": ORIGIN})
    with client.open(login, timeout=60) as response:
        response.read()
    password = None
    if not list(jar):
        raise RuntimeError("Studio did not establish an owner session")

    def api(method, path, body=None):
        request = urllib.request.Request(ORIGIN + "/api" + path, method=method, headers={"Origin": ORIGIN, "Content-Type": "application/json"}, data=None if body is None else json.dumps(body).encode())
        with client.open(request, timeout=60) as response:
            return json.load(response)

    old = api("GET", "/authorizations")["items"]
    grant = api("POST", "/authorizations", {"name": NAME, "resource": "api", "scope": ["owner:read", "owner:draft", "owner:publish"]})
    token = grant["access_token"]
    try:
        subprocess.run(["gh", "secret", "set", "BLYG_API_TOKEN", "--repo", "diffplug/dormouse", "--env", "blyg-publish"], input=token, text=True, check=True)
    except Exception:
        api("DELETE", "/authorizations/" + urllib.parse.quote(grant["authorization"]["id"], safe=""))
        raise
    # Only revoke the grants this dedicated publisher previously owned, after
    # GitHub has accepted the replacement. Other clients' grants are untouched.
    for prior in old:
        if prior["name"] == NAME:
            api("DELETE", "/authorizations/" + urllib.parse.quote(prior["id"], safe=""))
    expires = datetime.datetime.fromtimestamp(grant["authorization"]["expiresAt"], datetime.timezone.utc)
    print(f"Publishing token saved to GitHub environment blyg-publish; expires {expires.isoformat()}.")
    if args.publish:
        subprocess.run(["node", "scripts/publish-blyg.mjs"], cwd=ROOT, env={**os.environ, "BLYG_API_TOKEN": token}, check=True)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        # Never print auth response bodies or request headers.
        path = urllib.parse.urlsplit(error.url).path
        raise SystemExit(f"HTTP {error.code} at {path}. Check Studio access and try again.")
    except (RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
