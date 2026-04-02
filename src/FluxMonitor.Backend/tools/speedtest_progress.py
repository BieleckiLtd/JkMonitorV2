#!/usr/bin/env python3

import argparse
import importlib.util
import json
import shutil
import sys
from importlib.machinery import SourceFileLoader

STEP_COUNT = 3
STAGE_INDEX = {
    "ping": 1,
    "download": 2,
    "upload": 3,
}


def emit(payload, *, error=False):
    stream = sys.stderr if error else sys.stdout
    stream.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    stream.flush()


def clamp_percent(value):
    return max(0, min(100, int(round(value))))


def load_speedtest_module():
    executable = shutil.which("speedtest-cli")
    if not executable:
        raise RuntimeError("speedtest-cli is not installed on this device yet. Run the installer or updater first.")

    loader = SourceFileLoader("fluxmonitor_speedtest_cli", executable)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise RuntimeError("The installed speedtest-cli script could not be loaded.")

    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def build_result_payload(speedtest, *, final=False):
    results = getattr(speedtest, "results", None)
    if results is None:
        return None

    if final and hasattr(results, "dict"):
        return results.dict()

    share_value = getattr(results, "share", None)
    if callable(share_value):
        share_value = None

    config = getattr(speedtest, "config", None) or {}
    client = config.get("client") if isinstance(config, dict) else None

    return {
        "download": getattr(results, "download", None),
        "upload": getattr(results, "upload", None),
        "ping": getattr(results, "ping", None),
        "server": getattr(results, "server", None),
        "timestamp": None,
        "bytes_sent": getattr(results, "bytes_sent", None),
        "bytes_received": getattr(results, "bytes_received", None),
        "share": share_value,
        "client": client,
    }


def emit_progress(stage, stage_percent, status_message, speedtest, *, final_result=False):
    step_index = STAGE_INDEX[stage]
    clamped_stage_percent = clamp_percent(stage_percent)
    percent_complete = clamp_percent((((step_index - 1) + (clamped_stage_percent / 100.0)) / STEP_COUNT) * 100)

    emit(
        {
            "stage": stage,
            "statusMessage": status_message,
            "stepIndex": step_index,
            "stepCount": STEP_COUNT,
            "stagePercentComplete": clamped_stage_percent,
            "percentComplete": percent_complete,
            "result": build_result_payload(speedtest, final=final_result),
        }
    )


def create_transfer_callback(stage, speedtest):
    state = {
        "completed": 0,
        "lastPercent": -1,
    }

    def callback(_current, total, start=False, end=False):
        if start and state["lastPercent"] < 0:
            state["lastPercent"] = 0
            emit_progress(stage, 0, f"Measuring {stage} speed.", speedtest)

        if not end or total <= 0:
            return

        state["completed"] += 1
        percent = clamp_percent((state["completed"] / float(total)) * 100.0)
        if percent == state["lastPercent"]:
            return

        state["lastPercent"] = percent
        emit_progress(stage, percent, f"Measuring {stage} speed.", speedtest)

    return callback


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--secure", action="store_true")
    parser.add_argument("--no-pre-allocate", dest="pre_allocate", action="store_false", default=True)
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        speedtest_module = load_speedtest_module()

        emit_progress("ping", 0, "Loading speed test configuration.", None)
        speedtest = speedtest_module.Speedtest(timeout=args.timeout, secure=args.secure)

        emit_progress("ping", 25, "Retrieving speed test server list.", speedtest)
        speedtest.get_servers()

        emit_progress("ping", 70, "Selecting best server based on ping.", speedtest)
        speedtest.get_best_server()

        emit_progress("ping", 100, "Ping measured. Starting download test.", speedtest)

        emit_progress("download", 0, "Measuring download speed.", speedtest)
        speedtest.download(callback=create_transfer_callback("download", speedtest))
        emit_progress("download", 100, "Download measured. Starting upload test.", speedtest)

        emit_progress("upload", 0, "Measuring upload speed.", speedtest)
        speedtest.upload(
            callback=create_transfer_callback("upload", speedtest),
            pre_allocate=args.pre_allocate,
        )
        emit_progress("upload", 100, "Upload measured. Finalizing result.", speedtest, final_result=True)
        return 0
    except Exception as exception:
        message = str(exception).strip() or exception.__class__.__name__
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
