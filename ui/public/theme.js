// Applied before first paint so dark mode does not flash.
(function () {
  try {
    var t = localStorage.getItem("sb-theme");
    if (!t) t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: stay light */ }
})();
