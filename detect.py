"""Find spores in a microscope photo and measure each one.

Pipeline:
  1. Work at a reduced size (long side <= MAX_SIDE) for speed.
  2. Flatten uneven lighting, then threshold so spores are foreground.
  3. Split touching spores with a distance-transform watershed.
  4. For each spore, measure its minimum-area rectangle: long side = length,
     short side = width. Q = length / width.

All lengths are returned in micrometres, using the ruler the user tapped.
"""

import cv2
import numpy as np

MAX_SIDE = 2000        # working resolution (long side, pixels)
MIN_AREA_PX = 30       # ignore specks smaller than this (working pixels)
MIN_SOLIDITY = 0.85    # below this the outline is irregular; flagged, still returned


def _foreground_mask(bgr):
    """Return a binary mask (255 = spore).

    Spores are yellow-brown and the slide is pale pink-beige, so the Lab "b" channel
    (blue-yellow) separates them well. A heavy blur first removes the granular texture
    inside each spore, so one spore becomes one blob.
    """
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    yellow = lab[:, :, 2]
    sigma = 0.01 * max(bgr.shape[:2])
    smooth = cv2.GaussianBlur(yellow, (0, 0), sigma)
    _, mask = cv2.threshold(smooth, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Spores are the minority of the frame. If Otsu chose the other side, flip it.
    if mask.mean() > 127:
        mask = cv2.bitwise_not(mask)
    # Opening with a kernel about 1.5% of the image removes thin bulges that leak into
    # neighbouring spores, and closing fills small gaps in each outline.
    k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_close)
    # Fill small holes inside spores.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
    # Trimmed copy, used only to find spores. The opening removes thin bulges that
    # leak into neighbours. The full copy keeps each spore's apex and pores.
    k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(3, int(0.015 * max(bgr.shape[:2])) | 1),) * 2)
    trimmed = cv2.morphologyEx(filled, cv2.MORPH_OPEN, k_open)
    return trimmed, filled


def _split_touching(mask):
    """Split clumps into single spores with a distance-transform watershed.

    Returns an int label image: 0 = unknown, 1 = background, 2.. = spores.
    """
    n, comp = cv2.connectedComponents(mask)
    if n < 2:
        return None
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)

    # One marker per spore: the thick core of each blob, where the distance from
    # the edge is at least 90% of its maximum. A single spore has one such core.
    # Two spores joined by a narrow neck get two cores, so the watershed splits them.
    core = np.zeros(mask.shape, dtype=np.uint8)
    for i in range(1, n):
        in_blob = comp == i
        dmax = dist[in_blob].max()
        if dmax < 2:
            continue
        core[in_blob & (dist >= 0.9 * dmax)] = 1
    _, core_labels = cv2.connectedComponents(core)
    # Give every pixel of the blob to its nearest spore core. A neck is split at its
    # midpoint, which is close enough for spores of similar size.
    not_core = (core == 0).astype(np.uint8)
    _, nearest = cv2.distanceTransformWithLabels(not_core, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_CCOMP)
    markers = np.zeros(mask.shape, dtype=np.int32)
    markers[mask > 0] = nearest[mask > 0] + 1
    markers[mask == 0] = 1
    return _merge_wide_necks(markers, dist)


def _merge_wide_necks(markers, dist):
    """Join two neighbouring regions when the line between them is nearly as wide as
    the spores. Two real spores touch at a narrow neck, so they stay apart."""
    labels = [int(l) for l in np.unique(markers) if l >= 2]
    if len(labels) < 2:
        return markers
    radius = {l: float(dist[markers == l].max()) for l in labels}
    parent = {l: l for l in labels}

    def find(a):
        while parent[a] != a:
            a = parent[a]
        return a

    for a in labels:
        region_a = (markers == a).astype(np.uint8)
        grown = cv2.dilate(region_a, np.ones((3, 3), np.uint8))
        neighbours = np.unique(markers[(grown > 0) & (region_a == 0)])
        for b in neighbours:
            b = int(b)
            if b < 2 or b == a:
                continue
            boundary = int(((markers == b) & (grown > 0)).sum())
            smaller = min(radius[a], radius[b])
            if boundary >= 1.2 * smaller:  # boundary at least ~60% of the smaller spore's width
                parent[find(a)] = find(b)

    merged = markers.copy()
    for l in labels:
        root = find(l)
        if root != l:
            merged[markers == l] = root
    return merged


def _measure_region(region_mask, min_area_px):
    """Return (length_px, width_px, solidity, touches_edge, contour) or None."""
    area = int(region_mask.sum())
    if area < min_area_px:
        return None
    contours, _ = cv2.findContours(region_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull)
    solidity = area / hull_area if hull_area > 0 else 0.0
    contour = hull  # spores are convex; the hull restores any part the mask lost
    (_, _), (w, h), _ = cv2.minAreaRect(contour)
    length_px, width_px = max(w, h), min(w, h)
    ys, xs = np.nonzero(region_mask)
    touches_edge = bool(
        xs.min() == 0 or ys.min() == 0 or xs.max() == region_mask.shape[1] - 1 or ys.max() == region_mask.shape[0] - 1
    )
    return length_px, width_px, solidity, touches_edge, contour


def measure_spores(bgr, ruler_px, ticks, um_per_tick, tips=()):
    """Detect and measure spores.

    bgr: the photo (BGR, full resolution).
    ruler_px: ((x1, y1), (x2, y2)) of the two ruler taps, in full-resolution pixels.
    ticks: number of ruler ticks between those two taps.
    um_per_tick: micrometres per tick at this magnification.
    tips: optional (x, y) points, full-resolution pixels, marking an apical tip the
          automatic outline missed. Each tip joins the nearest spore's outline.

    Returns dict with 'um_per_px' and 'spores'. Each spore: id, length, width, q,
    flag, contour (full-resolution points).
    """
    h, w = bgr.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))  # working size / full size
    work = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else bgr

    (x1, y1), (x2, y2) = ruler_px
    ruler_full = float(np.hypot(x2 - x1, y2 - y1))
    if ruler_full <= 0 or ticks <= 0 or um_per_tick <= 0:
        raise ValueError("ruler taps, tick count and µm per tick must all be set")
    um_per_full_px = (ticks * um_per_tick) / ruler_full
    # One working pixel covers 1/scale full-resolution pixels.
    um_per_work_px = um_per_full_px / scale

    mask, full_mask = _foreground_mask(work)
    min_area_px = 0.003 * work.shape[0] * work.shape[1]  # smaller blobs are debris
    wall_px = int(round(0.012 * max(work.shape[:2])))   # yellow mask stops inside the wall
    reach_px = int(round(0.03 * max(work.shape[:2])))   # how far a spore may claim protrusions

    markers = _split_touching(mask)
    spores = []
    tips_used = []
    if markers is None:
        return {"um_per_px": um_per_full_px, "spores": spores, "tips_used": tips_used}

    labels = [int(l) for l in np.unique(markers) if l >= 2]

    # The trimmed mask cut off thin protrusions. Let each spore claim full-mask pixels
    # within reach of its own region, so those parts are kept.
    owner = markers.copy()
    reach = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach_px + 1, 2 * reach_px + 1))
    for label in labels:
        grown = cv2.dilate(np.where(markers == label, 255, 0).astype(np.uint8), reach)
        owner[(grown > 0) & (full_mask > 0) & (owner < 2)] = label

    regions = []
    for label in labels:
        region = np.where((owner == label) & (full_mask > 0), 255, 0).astype(np.uint8)
        if region.any():
            regions.append(region)

    # Remember each spore's centre before any tips change its outline, so numbering stays
    # stable when a tip is added.
    centres = []
    for region in regions:
        m = cv2.moments(region, binaryImage=True)
        centres.append((m["m01"] / m["m00"], m["m10"] / m["m00"]) if m["m00"] else (0.0, 0.0))

    # Each tip joins the spore whose outline is nearest to it.
    for tx, ty in tips:
        tw, th = tx * scale, ty * scale
        best, best_d, best_pt = None, float("inf"), None
        for region in regions:
            cs, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if not cs:
                continue
            outline = max(cs, key=cv2.contourArea).reshape(-1, 2).astype(float)
            dists = np.hypot(outline[:, 0] - tw, outline[:, 1] - th)
            i = int(np.argmin(dists))
            if dists[i] < best_d:
                best, best_d, best_pt = region, dists[i], outline[i]
        # A tip must sit close to a spore. A far tap would stretch that spore's outline.
        if best is not None and best_d <= 0.15 * max(work.shape[:2]):
            # Join the tip to the nearest outline point with a short thick line, so the
            # tip counts as part of the spore for its length and width.
            p0 = (int(round(best_pt[0])), int(round(best_pt[1])))
            cv2.line(best, p0, (int(round(tw)), int(round(th))), 255, thickness=5)
            cv2.circle(best, (int(round(tw)), int(round(th))), 3, 255, -1)
            tips_used.append([tx, ty])

    wall = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * wall_px + 1, 2 * wall_px + 1))
    measured = []
    for region, centre in zip(regions, centres):
        if wall_px > 0:
            # Grow the mask outward by about the wall thickness, to the outer edge.
            region = cv2.dilate(region, wall)
        result = _measure_region(region, min_area_px)
        if result is None:
            continue
        length_px, width_px, solidity, touches_edge, contour = result
        if touches_edge:
            continue  # cut off by the frame, so the size would be wrong
        length = length_px * um_per_work_px
        width = width_px * um_per_work_px
        flag = "" if solidity >= MIN_SOLIDITY else "irregular outline"
        full_contour = (contour.reshape(-1, 2) / scale).round().astype(int).tolist()
        measured.append((centre, {
            "length": float(length),
            "width": float(width),
            "q": float(length / width) if width > 0 else None,
            "flag": flag,
            "contour": full_contour,
        }))

    measured.sort(key=lambda item: (round(item[0][0] / 10), item[0][1]))  # rows, then left to right
    spores = [spore for _, spore in measured]
    for i, s in enumerate(spores, 1):
        s["id"] = i
    return {"um_per_px": um_per_full_px, "spores": spores, "tips_used": tips_used}
