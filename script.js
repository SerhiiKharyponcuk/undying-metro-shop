const LINKS = {
  shop: "https://t.me/UNDYINGmetroSHOP",
  donate: "",
  telegram: "https://t.me/UNDYINGmetroSHOP",
  developer: "https://github.com/SerhiiKharyponcuk",
};

const toast = document.querySelector("#toast");
const preloader = document.querySelector("#preloader");
const loaderBar = document.querySelector("#loaderBar");
const loaderPercent = document.querySelector("#loaderPercent");
const linkTransition = document.querySelector("#linkTransition");
const transitionEyebrow = document.querySelector("#transitionEyebrow");
const transitionTitle = document.querySelector("#transitionTitle");
let toastTimer;
let loadingProgress = 0;

function updateLoader(value) {
  loadingProgress = Math.min(100, Math.max(0, Math.round(value)));
  loaderBar.style.width = `${loadingProgress}%`;
  loaderPercent.value = `${loadingProgress}%`;
  loaderPercent.textContent = `${loadingProgress}%`;
}

const loaderInterval = window.setInterval(() => {
  if (loadingProgress >= 91) return;
  const step = loadingProgress < 55 ? 7 : loadingProgress < 80 ? 3 : 1;
  updateLoader(loadingProgress + step);
}, 90);

const loaderStartedAt = performance.now();

function finishPageLoading() {
  const minimumVisibleTime = 1250;
  const delay = Math.max(0, minimumVisibleTime - (performance.now() - loaderStartedAt));

  window.setTimeout(() => {
    window.clearInterval(loaderInterval);
    updateLoader(100);

    window.setTimeout(() => {
      preloader.classList.add("is-complete");
      document.documentElement.classList.add("page-ready");
      window.setTimeout(() => {
        preloader.hidden = true;
      }, 650);
    }, 230);
  }, delay);
}

if (document.readyState === "complete") {
  finishPageLoading();
} else {
  window.addEventListener("load", finishPageLoading, { once: true });
}

function showPlaceholderMessage() {
  window.clearTimeout(toastTimer);
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
}

function isSafeDestination(url) {
  try {
    const destination = new URL(url, window.location.href);
    return ["https:", "http:", "tg:"].includes(destination.protocol);
  } catch {
    return false;
  }
}

function getLinkLabel(link) {
  return (
    link.dataset.transitionLabel ||
    link.querySelector("strong")?.textContent?.trim() ||
    link.querySelector("span:last-child")?.textContent?.trim() ||
    "Undying Metro Shop"
  );
}

function addTapRipple(link, event) {
  const rect = link.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "tap-ripple";
  ripple.style.left = `${event.clientX ? event.clientX - rect.left : rect.width / 2}px`;
  ripple.style.top = `${event.clientY ? event.clientY - rect.top : rect.height / 2}px`;
  link.appendChild(ripple);
  window.setTimeout(() => ripple.remove(), 650);
}

function openWithTransition(url, link) {
  const telegramLink = link.dataset.link === "telegram" || /(?:t\.me|telegram\.me)/i.test(url) || url.startsWith("tg:");
  const label = getLinkLabel(link);

  linkTransition.classList.toggle("is-telegram", telegramLink);
  transitionEyebrow.textContent = telegramLink ? "ОТКРЫВАЕМ TELEGRAM" : "ПЕРЕХОДИМ ПО ССЫЛКЕ";
  transitionTitle.textContent = label;
  linkTransition.classList.add("is-active");
  linkTransition.setAttribute("aria-hidden", "false");

  window.setTimeout(() => {
    window.location.assign(url);
  }, 1050);
}

window.UNDYING_NAVIGATION = Object.freeze({
  isSafeDestination,
  openWithTransition,
  showPlaceholderMessage,
});

document.querySelectorAll("[data-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const url = LINKS[link.dataset.link];

    addTapRipple(link, event);

    if (!url || !isSafeDestination(url)) {
      showPlaceholderMessage();
      return;
    }

    openWithTransition(url, link);
  });
});

window.addEventListener("pageshow", () => {
  linkTransition.classList.remove("is-active");
  linkTransition.setAttribute("aria-hidden", "true");
});

const particles = document.querySelector("#particles");
const particleColors = ["#55f4e1", "#19cbbd", "#ffb348"];

for (let index = 0; index < 22; index += 1) {
  const particle = document.createElement("span");
  particle.className = "particle";
  particle.style.setProperty("--x", `${Math.random() * 100}%`);
  particle.style.setProperty("--size", `${1 + Math.random() * 2.6}px`);
  particle.style.setProperty("--duration", `${10 + Math.random() * 12}s`);
  particle.style.setProperty("--delay", `${Math.random() * -20}s`);
  particle.style.setProperty("--drift", `${-55 + Math.random() * 110}px`);
  particle.style.setProperty(
    "--color",
    particleColors[Math.floor(Math.random() * particleColors.length)],
  );
  particles.appendChild(particle);
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  window.addEventListener(
    "pointermove",
    (event) => {
      document.documentElement.style.setProperty("--pointer-x", `${event.clientX}px`);
      document.documentElement.style.setProperty("--pointer-y", `${event.clientY}px`);
    },
    { passive: true },
  );
}
