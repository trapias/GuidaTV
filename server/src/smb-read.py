"""Copy a selected byte range from the configured SMB share to stdout."""

import sys

from smbclient import open_file, register_session


def main():
    credentials_path, host, share, filename, start, count = sys.argv[1:]
    with open(credentials_path, encoding="utf-8") as credentials:
        entries = {}
        for line in credentials:
            key, separator, value = line.strip().partition("=")
            if separator and not key.startswith(("#", ";")):
                entries[key.strip()] = value
    username = entries["username"]
    if entries.get("domain") and "\\" not in username and "@" not in username:
        username = f'{entries["domain"]}\\{username}'
    register_session(host, username=username, password=entries["password"], connection_timeout=8)
    path = "\\\\" + "\\".join((host, share, filename))
    with open_file(path, mode="rb", share_access="rwd") as source:
        source.seek(int(start))
        remaining = int(count)
        while remaining:
            chunk = source.read(min(remaining, 512 * 1024))
            if not chunk:
                raise IOError("Lettura SMB incompleta")
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
