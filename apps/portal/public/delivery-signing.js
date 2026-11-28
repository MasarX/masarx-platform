(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;

  const form = document.querySelector("form");
  const fieldset = form.querySelector("fieldset");
  const canvas = form.querySelector("canvas");
  const context = canvas.getContext("2d");
  const submit = form.querySelector('button[type="submit"]');
  const status = document.querySelector("#status");
  const copy = status.dataset;
  if (!context) {
    status.textContent = copy.unavailable;
    return;
  }

  const center = { x: canvas.width / 2, y: canvas.height / 2 };
  let cursor = center;
  let pointerId = null;
  let keyboardInk = false;
  let drawn = false;
  let sending = false;
  let ended = false;
  const ink = "#162d36";

  function lockPad(locked) {
    fieldset.disabled = locked;
    canvas.tabIndex = locked ? -1 : 0;
    canvas.setAttribute("aria-disabled", String(locked));
  }

  function draw(next) {
    if (cursor.x === next.x && cursor.y === next.y) return;
    context.beginPath();
    context.moveTo(cursor.x, cursor.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    drawn = true;
    submit.disabled = false;
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    return { x: Math.max(1, Math.min(canvas.width - 1, x)), y: Math.max(1, Math.min(canvas.height - 1, y)) };
  }

  context.strokeStyle = ink;
  context.lineWidth = 3;
  context.lineCap = "round";
  canvas.addEventListener("pointerdown", (event) => {
    if (sending || ended || pointerId !== null || event.button !== 0) return;
    keyboardInk = false;
    pointerId = event.pointerId;
    cursor = point(event);
    canvas.setPointerCapture(pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (sending || ended || pointerId !== event.pointerId) return;
    const next = point(event);
    draw(next);
    cursor = next;
  });
  canvas.addEventListener("lostpointercapture", () => { pointerId = null; });
  canvas.addEventListener("blur", () => { keyboardInk = false; });
  canvas.addEventListener("keydown", (event) => {
    if (sending || ended || pointerId !== null) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) {
        keyboardInk = !keyboardInk;
        status.textContent = keyboardInk ? copy.drawing : copy.paused;
      }
      return;
    }
    const directions = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
    const direction = directions[event.key];
    if (!Array.isArray(direction)) return;
    event.preventDefault();
    const next = {
      x: Math.max(1, Math.min(canvas.width - 1, cursor.x + direction[0])),
      y: Math.max(1, Math.min(canvas.height - 1, cursor.y + direction[1])),
    };
    if (keyboardInk) draw(next);
    cursor = next;
  });
  form.querySelector("#clear").addEventListener("click", () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    cursor = center;
    keyboardInk = false;
    drawn = false;
    submit.disabled = true;
    status.textContent = copy.cleared;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!drawn || sending || ended) return;
    sending = true;
    lockPad(true);
    status.textContent = copy.sending;
    try {
      const image = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!image) throw new Error("signature_unavailable");
      const result = await fetch(location.pathname, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "image/png", "X-Signing-Token": token },
        body: image,
      });
      if (result.status === 204 || result.status === 409) {
        ended = true;
        context.clearRect(0, 0, canvas.width, canvas.height);
        status.textContent = result.status === 204
          ? copy.received
          : copy.expired;
        return;
      }
      throw new Error("signature_not_confirmed");
    } catch {
      status.textContent = copy.failed;
    } finally {
      sending = false;
      lockPad(ended);
      if (!ended) submit.focus();
    }
  });
  lockPad(false);
  status.textContent = copy.ready;
})();
