(function () {
  try {
    var pref = localStorage.getItem("gw-theme") || "system";
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = pref === "system" ? (prefersDark ? "dark" : "light") : pref;
    document.documentElement.classList.toggle("gw-light", resolved === "light");
  } catch (e) {}
})();
