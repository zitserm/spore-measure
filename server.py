"""Serve the Spore Measure page and measure spores from uploaded photos.

Run on the Mac:  ./.venv/bin/python server.py
Then open http://<this-mac's-address>:8000 on the phone (same Wi-Fi or Tailscale).
"""

import json

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_from_directory

from detect import measure_spores

app = Flask(__name__, static_folder=".", static_url_path="")


@app.get("/")
def index():
    return send_from_directory(".", "index.html")


@app.post("/measure")
def measure():
    upload = request.files.get("image")
    if upload is None:
        return jsonify(error="No photo was received."), 400
    try:
        ruler = json.loads(request.form["ruler"])
        ticks = float(request.form["ticks"])
        um_per_tick = float(request.form["um_per_tick"])
        (x1, y1), (x2, y2) = ruler
        tips = [(float(x), float(y)) for x, y in json.loads(request.form.get("tips", "[]"))]
    except (KeyError, ValueError, TypeError) as exc:
        return jsonify(error=f"Missing or bad calibration values: {exc}"), 400

    data = np.frombuffer(upload.read(), dtype=np.uint8)
    bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if bgr is None:
        return jsonify(error="That file is not a photo this app can read."), 400

    try:
        result = measure_spores(bgr, ((x1, y1), (x2, y2)), ticks, um_per_tick, tips)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    result["image_width"] = int(bgr.shape[1])
    result["image_height"] = int(bgr.shape[0])
    return jsonify(result)


if __name__ == "__main__":
    # 0.0.0.0 so the phone on Wi-Fi or Tailscale can reach it.
    app.run(host="0.0.0.0", port=8000, debug=False)
