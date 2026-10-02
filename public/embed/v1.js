/*! Lead form embed v1 (ES5). <script src="APP/embed/v1.js" data-form="evpk_..." data-mode="inline|button" data-label="Get a quote" async>
 * See docs/website-forms.md. UI lives in an iframe / shadow root: no style leaks. */
(function () {
  "use strict";
  var W = window, D = document;
  var UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
  var frames = [];

  function originOf(src) {
    var a = D.createElement("a");
    a.href = src;
    return a.protocol + "//" + a.host;
  }

  function formUrl(base, key) {
    var q = "?embed=1&page=" + encodeURIComponent(String(W.location.href).slice(0, 1000));
    var params = W.location.search.replace(/^\?/, "").split("&");
    for (var i = 0; i < params.length; i++) {
      var kv = params[i].split("=");
      if (kv[0] && UTM.indexOf(kv[0]) !== -1 && kv[1]) q += "&" + kv[0] + "=" + kv[1].slice(0, 200);
    }
    return base + "/f/" + encodeURIComponent(key) + q;
  }

  function makeFrame(base, key, title) {
    var f = D.createElement("iframe");
    f.src = formUrl(base, key);
    f.title = title;
    f.setAttribute("scrolling", "no");
    f.style.cssText = "display:block;width:100%;height:560px;border:0;margin:0;background:transparent;";
    frames.push({ el: f, origin: base });
    return f;
  }

  W.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object" || d.type !== "evform:resize") return;
    for (var i = 0; i < frames.length; i++) {
      var fr = frames[i];
      if (fr.origin === e.origin && fr.el.contentWindow === e.source) {
        var h = parseInt(d.height, 10);
        if (h > 0 && h < 5000) fr.el.style.height = h + 8 + "px";
      }
    }
  });

  function shadowHost() {
    var host = D.createElement("div");
    host.style.cssText = "all:initial;";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    return { host: host, root: root };
  }

  function mountButton(base, key, label, color) {
    var s = shadowHost();
    var css = D.createElement("style");
    css.textContent =
      ".b{position:fixed;right:20px;bottom:20px;z-index:2147483000;font:600 15px/1.2 system-ui,Arial,sans-serif;color:#fff;background:" + color + ";border:0;border-radius:999px;padding:14px 20px;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}" +
      ".o{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.6);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 12px}" +
      ".o.on{display:flex}.m{position:relative;width:100%;max-width:520px;margin:auto 0}" +
      ".x{position:absolute;top:-12px;right:-6px;width:36px;height:36px;border-radius:50%;border:0;background:#fff;color:#0f172a;font:400 22px/36px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}";
    var btn = D.createElement("button");
    btn.className = "b";
    btn.type = "button";
    btn.textContent = label;
    var overlay = D.createElement("div");
    overlay.className = "o";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var modal = D.createElement("div");
    modal.className = "m";
    var close = D.createElement("button");
    close.className = "x";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\u00d7";
    var frame = null;
    function hide() { overlay.className = "o"; }
    btn.onclick = function () {
      if (!frame) { frame = makeFrame(base, key, label); modal.appendChild(frame); }
      overlay.className = "o on";
    };
    close.onclick = hide;
    overlay.onclick = function (e) { if (e.target === overlay) hide(); };
    D.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
    modal.appendChild(close);
    overlay.appendChild(modal);
    s.root.appendChild(css);
    s.root.appendChild(btn);
    s.root.appendChild(overlay);
    D.body.appendChild(s.host);
  }

  function init(script) {
    if (script.getAttribute("data-evf-done")) return;
    script.setAttribute("data-evf-done", "1");
    var key = script.getAttribute("data-form");
    if (!key) return;
    var base = originOf(script.src);
    var mode = script.getAttribute("data-mode") === "button" ? "button" : "inline";
    var label = script.getAttribute("data-label") || "Get a quote";
    var color = script.getAttribute("data-color") || "#0f172a";
    if (!/^#[0-9a-f]{3,8}$/i.test(color)) color = "#0f172a";
    if (mode === "button") {
      if (D.body) mountButton(base, key, label, color);
      else D.addEventListener("DOMContentLoaded", function () { mountButton(base, key, label, color); });
      return;
    }
    if (script.parentNode) script.parentNode.insertBefore(makeFrame(base, key, label), script.nextSibling);
  }

  var scripts = D.getElementsByTagName("script");
  for (var i = 0; i < scripts.length; i++) {
    if (scripts[i].getAttribute("data-form") && /\/embed\/v1\.js(\?|$)/.test(scripts[i].src)) init(scripts[i]);
  }
})();
