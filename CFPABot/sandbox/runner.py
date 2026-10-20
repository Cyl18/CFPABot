#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time

SEND_LOCK = threading.Lock()


def send(message):
    line = json.dumps(message, ensure_ascii=False)
    with SEND_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def pump(stream, kind):
    for chunk in iter(lambda: stream.read(65536), b""):
        send({"type": kind, "data": chunk.decode("utf-8", "replace")})


def kill_tree(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (AttributeError, ProcessLookupError, PermissionError):
        process.kill()


def main():
    raw = sys.stdin.readline()
    if not raw:
        return
    request = json.loads(raw)
    language = request["language"]
    code = request["code"]
    stdin_data = request.get("stdin")
    suffix = {"py": ".py", "js": ".js", "bash": ".sh"}[language]
    path = os.path.join(tempfile.gettempdir(), f"cell{suffix}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(code)
    command = {
        "py": [sys.executable, "-u", path],
        "js": ["bun", path],
        "bash": ["bash", path],
    }[language]
    started = time.time()
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    if stdin_data is not None:
        process.stdin.write(stdin_data.encode("utf-8"))
        process.stdin.close()
    threads = [
        threading.Thread(target=pump, args=(process.stdout, "stdout"), daemon=True),
        threading.Thread(target=pump, args=(process.stderr, "stderr"), daemon=True),
    ]
    for thread in threads:
        thread.start()

    state = {"cancelled": False}

    def watch_cancel():
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "cancel":
                state["cancelled"] = True
                kill_tree(process)
                return
        kill_tree(process)

    threading.Thread(target=watch_cancel, daemon=True).start()
    exit_code = process.wait()
    for thread in threads:
        thread.join()
    send(
        {
            "type": "result",
            "exitCode": exit_code,
            "durationMs": int((time.time() - started) * 1000),
            "cancelled": state["cancelled"],
        }
    )


if __name__ == "__main__":
    main()
