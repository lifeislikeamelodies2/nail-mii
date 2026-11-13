/* Nail Mii image analyzer. Images never leave this device.
 * Coin: gradient-based circle search; nails: MediaPipe fingertips + local edge scan.
 * No measurement is saved by the detector: the user verifies the proposed endpoints.
 */
(function (root) {
  'use strict';
  const MODEL_VERSION = '1.2.3';
  const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MODEL_VERSION;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  let detectorPromise = null;

  function photoData(photo, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(photo.width, photo.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(photo.width * scale));
    canvas.height = Math.max(2, Math.round(photo.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(photo, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, pixels: data.data, scale };
  }

  function circleCandidates(preview) {
    const { width: w, height: h, pixels } = preview;
    const n = w * h, gray = new Float32Array(n), gx = new Float32Array(n),
      gy = new Float32Array(n), grad = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      gray[i] = pixels[p] * .299 + pixels[p + 1] * .587 + pixels[p + 2] * .114;
    }
    const minR = Math.max(10, Math.round(Math.min(w, h) * .025));
    const maxR = Math.min(125, Math.round(Math.min(w, h) * .24));
    const accumulator = new Uint16Array(n);
    const edges = [];
    let maxGradient = 0;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const dx = gray[i + 1 - w] + 2 * gray[i + 1] + gray[i + 1 + w]
                 - gray[i - 1 - w] - 2 * gray[i - 1] - gray[i - 1 + w];
        const dy = gray[i - 1 + w] + 2 * gray[i + w] + gray[i + 1 + w]
                 - gray[i - 1 - w] - 2 * gray[i - w] - gray[i + 1 - w];
        const m = Math.hypot(dx, dy);
        gx[i] = dx; gy[i] = dy; grad[i] = m;
        if (m > maxGradient) maxGradient = m;
      }
    }
    const cutoff = Math.max(78, maxGradient * .14);
    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        const i = y * w + x, m = grad[i];
        if (m < cutoff) continue;
        edges.push({ x, y, dx: gx[i] / m, dy: gy[i] / m, m });
      }
    }
    if (edges.length < 35) return [];
    // Cap work for high-texture backgrounds. Deterministic spatial subsampling.
    const stride = Math.max(1, Math.ceil(edges.length / 12500));
    for (let k = 0; k < edges.length; k += stride) {
      const { x, y, dx, dy } = edges[k];
      for (let r = minR; r <= maxR; r += 3) {
        for (let sign = -1; sign <= 1; sign += 2) {
          const cx = Math.round(x + dx * r * sign);
          const cy = Math.round(y + dy * r * sign);
          if (cx > maxR / 3 && cy > maxR / 3 && cx < w - maxR / 3 && cy < h - maxR / 3) accumulator[cy * w + cx]++;
        }
      }
    }
    const centers = [];
    for (let y = minR; y < h - minR; y += 2) {
      for (let x = minR; x < w - minR; x += 2) {
        const votes = accumulator[y * w + x];
        if (votes > 8) centers.push({ x, y, votes });
      }
    }
    centers.sort((a, b) => b.votes - a.votes);
    const bestCenters = [];
    for (const candidate of centers) {
      if (bestCenters.every(c => Math.hypot(c.x - candidate.x, c.y - candidate.y) > 9)) bestCenters.push(candidate);
      if (bestCenters.length >= 22) break;
    }
    const angles = Array.from({ length: 96 }, (_, i) => i * 2 * Math.PI / 96);
    const cos = angles.map(Math.cos), sin = angles.map(Math.sin);
    const results = [];
    for (const c of bestCenters) {
      for (let r = minR; r <= maxR; r += 2) {
        if (c.x - r < 2 || c.y - r < 2 || c.x + r >= w - 2 || c.y + r >= h - 2) continue;
        let coverage = 0, alignment = 0, energy = 0;
        for (let j = 0; j < angles.length; j++) {
          const x = Math.round(c.x + cos[j] * r), y = Math.round(c.y + sin[j] * r), i = y * w + x;
          const m = grad[i], radial = (gx[i] * cos[j] + gy[i] * sin[j]) / (m || 1);
          if (m > cutoff * .65 && Math.abs(radial) > .48) coverage++;
          energy += Math.min(m / (cutoff * 3), 1) * Math.abs(radial);
          alignment += Math.abs(radial);
        }
        const cover = coverage / angles.length, edge = energy / angles.length;
        if (cover < .40) continue;
        const score = cover * .72 + edge * .28;
        results.push({ x: c.x, y: c.y, r, score, cover, edge });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  function detectCoin(photo) {
    const src = photoData(photo, 540), circles = circleCandidates(src);
    const best = circles.find(c => c.cover >= .52 && c.score >= .54 && c.r >= 11);
    if (!best) return null;
    // Circle is symmetric; a horizontal diameter avoids diagonal placement uncertainty.
    const cx = best.x / src.scale, cy = best.y / src.scale, r = best.r / src.scale;
    return {
      points: [{ x: cx - r, y: cy }, { x: cx + r, y: cy }],
      circle: { x: cx, y: cy, r },
      confidence: best.score,
      note: '硬貨の輪郭を推定しました。円と硬貨の縁が一致するか確認してください。'
    };
  }

  function interpolate(pixels, w, h, x, y) {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1) return null;
    const i = (iy * w + ix) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  }
  function colorContrast(a, b) {
    if (!a || !b) return 0;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 1.732;
  }
  function analyzeNail(preview, tip, dip, radiusLimit) {
    const { width: w, height: h, pixels } = preview;
    const t = { x: tip.x * w, y: tip.y * h }, d = { x: dip.x * w, y: dip.y * h };
    const L = Math.hypot(t.x - d.x, t.y - d.y);
    if (L < 15) return null;
    const ux = (d.x - t.x) / L, uy = (d.y - t.y) / L, vx = -uy, vy = ux;
    const center = { x: t.x + ux * L * .43, y: t.y + uy * L * .43 };
    // Sample cross sections in the widest middle portion of the nail.
    const longitudinal = [.33, .42, .51, .58];
    const sample = (l, across) => interpolate(pixels, w, h,
      t.x + ux * L * l + vx * across,
      t.y + uy * L * l + vy * across);
    const step = Math.max(1.4, Math.min(3, L * .032));
    let winner = null;
    for (let half = L * .27; half <= L * .82; half += step) {
      for (let shift = -L * .09; shift <= L * .09; shift += step * 1.7) {
        let leftScore = 0, rightScore = 0;
        const gap = Math.max(1.5, L * .045);
        for (const f of longitudinal) {
          const innerLeft = sample(f, shift - half + gap);
          const outerLeft = sample(f, shift - half - gap);
          const innerRight = sample(f, shift + half - gap);
          const outerRight = sample(f, shift + half + gap);
          leftScore += colorContrast(innerLeft, outerLeft);
          rightScore += colorContrast(innerRight, outerRight);
        }
        leftScore /= longitudinal.length;
        rightScore /= longitudinal.length;
        const balance = Math.min(leftScore, rightScore) / (Math.max(leftScore, rightScore) + .01);
        // Strong bilateral edges matter more than one bright reflection.
        const strength = Math.min(leftScore, rightScore) * (.73 + .27 * balance);
        const width = half * 2 / preview.scale;
        if (radiusLimit && (width < radiusLimit.min || width > radiusLimit.max)) continue;
        if (!winner || strength > winner.strength)
          winner = { half, shift, leftScore, rightScore, strength, f: .46 };
      }
    }
    // Natural nails can have very little contrast. Uncertain proposals are not used.
    if (!winner || winner.strength < 9 || Math.min(winner.leftScore, winner.rightScore) < 7) return null;
    const p = (side) => ({
      x: (t.x + ux * L * winner.f + vx * (winner.shift + side * winner.half)) / preview.scale,
      y: (t.y + uy * L * winner.f + vy * (winner.shift + side * winner.half)) / preview.scale
    });
    return { points: [p(-1), p(1)], confidence: Math.min(.94, winner.strength / 32), source: 'hand-landmarks-edge' };
  }

  async function getHandModel() {
    if (!detectorPromise) {
      detectorPromise = (async () => {
        const { FilesetResolver, HandLandmarker } = await import(BASE + '/vision_bundle.mjs');
        const fileset = await FilesetResolver.forVisionTasks(BASE + '/wasm');
        return HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'IMAGE', numHands: 1,
          minHandDetectionConfidence: .55
        });
      })().catch(error => { detectorPromise = null; throw error; });
    }
    return detectorPromise;
  }

  async function detectNails(photo, calibration, coinMm) {
    const handModel = await getHandModel();
    const found = handModel.detect(photo);
    const lms = found.landmarks && found.landmarks[0];
    if (!lms || lms.length < 21) return { nails: [null, null, null, null, null], foundHand: false };
    const preview = photoData(photo, 1200), nailIndices = [[4,3],[8,7],[12,11],[16,15],[20,19]];
    const coinPixels = calibration ? Math.hypot(calibration[0].x - calibration[1].x, calibration[0].y - calibration[1].y) : 0;
    const pixPerMm = coinPixels > 0 ? coinPixels / coinMm : 0;
    const limits = pixPerMm ? { min: 5 * pixPerMm, max: 25 * pixPerMm } : null;
    const nails = nailIndices.map(([tip, dip]) => analyzeNail(preview, lms[tip], lms[dip], limits));
    return { nails, foundHand: true, keypoints: lms };
  }
  root.NailMiiVision = Object.freeze({ detectCoin, detectNails });
})(window);
