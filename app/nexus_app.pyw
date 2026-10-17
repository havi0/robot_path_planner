"""NEXUS Robotics Studio - desktop launcher (Windows).

Double-click (or use the Desktop / Start Menu shortcut) to:
  1. start the NEXUS backend in the background if it is not already running,
  2. open the studio in its own app window (Microsoft Edge / Chrome "app mode":
     no address bar or tabs, own taskbar entry),
  3. stop the backend again when the window is closed - but only if this launcher
     started it (a server you started yourself is left running).

No extra dependencies. Logs: data/logs/app_launcher.log and data/logs/app_server.log.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("NEXUS_PORT", "8000"))
URL = f"http://127.0.0.1:{PORT}"
LOG_DIR = os.path.join(ROOT, "data", "logs")
PROFILE = os.path.join(os.environ.get("LOCALAPPDATA", ROOT), "NEXUS Studio", "window")
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def log(msg):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "app_launcher.log"), "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def server_status():
    """'nexus' if a NEXUS backend answers, 'other' if something else holds the port, None if free."""
    try:
        with urllib.request.urlopen(URL + "/api/health", timeout=1.5) as r:
            return "nexus" if json.load(r).get("status") == "ok" else "other"
    except urllib.error.HTTPError:
        return "other"
    except Exception:
        return None


def message(text):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, "NEXUS Robotics Studio", 0x10)
    except Exception:
        print(text)


def start_server():
    os.makedirs(LOG_DIR, exist_ok=True)
    out = open(os.path.join(LOG_DIR, "app_server.log"), "a", encoding="utf-8")
    exe = sys.executable
    if exe.lower().endswith("pythonw.exe"):          # console-less interpreter for the server too
        exe = exe[:-len("pythonw.exe")] + "python.exe" if os.path.exists(exe[:-len("pythonw.exe")] + "python.exe") else exe
    proc = subprocess.Popen([exe, "-W", "ignore", os.path.join(ROOT, "main.py"), "studio", "--port", str(PORT)],
                            cwd=ROOT, stdout=out, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
    log(f"started backend pid {proc.pid}")
    for _ in range(240):                              # model loading can take a while on first start
        if server_status() == "nexus":
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"the backend exited with code {proc.returncode} - see data/logs/app_server.log")
        time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("the backend did not start within 2 minutes - see data/logs/app_server.log")


def open_window():
    browser = next((b for b in BROWSERS if os.path.exists(b)), None)
    if not browser:
        import webbrowser
        webbrowser.open(URL)
        return None
    os.makedirs(PROFILE, exist_ok=True)
    # A dedicated profile makes this a separate process we can wait on (closing the window ends it).
    return subprocess.Popen([browser, f"--app={URL}", f"--user-data-dir={PROFILE}", "--window-size=1500,940",
                             "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"])


def main():
    owned = None
    status = server_status()
    if status == "other":
        message(f"Port {PORT} is used by another program. Close it, or set NEXUS_PORT to a free port.")
        return
    try:
        if status is None:
            owned = start_server()
        win = open_window()
        if win is not None and owned is not None:
            win.wait()                                # window closed
            # Edge can hand the window to an already-running instance of this profile and exit at once;
            # keep the backend alive while any window of our profile is still open.
            while _profile_running():
                time.sleep(2)
    except Exception as e:
        log(f"error: {e}")
        message(f"NEXUS could not start:\n{e}")
    finally:
        if owned is not None and owned.poll() is None:
            log("window closed - stopping backend")
            owned.terminate()
            try:
                owned.wait(timeout=10)
            except subprocess.TimeoutExpired:
                owned.kill()


def _profile_running():
    """True while a browser process with our dedicated app profile is alive."""
    try:
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | "
              "Select-Object -ExpandProperty CommandLine")
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW).stdout
        return PROFILE.lower() in out.lower()
    except Exception:
        return False


if __name__ == "__main__":
    main()
