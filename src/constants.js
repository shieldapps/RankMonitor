// Category name → numeric ID map
export const GENRE_MAP = {
  Business: 6000,
  Productivity: 6007,
  Utilities: 6002,
};

// chart type → RSS path fragment per platform
export const CHART_PATHS = {
  "top-free": {
    macos: "topfreemacapps",
    ios: "topfreeapplications",
    ipados: "topfreeipadapplications",
  },
  // Phase 2
  // "top-paid": {
  //   macos: "toppaidmacapps",
  //   ios: "toppaidapplications",
  //   ipados: "toppaidipadapplications",
  // },
  // "top-grossing": {
  //   macos: "topgrossingmacapps",
  //   ios: "topgrossingapplications",
  //   ipados: "topgrossingipadapplications",
  // },
};

// kind → default platform inference
export function inferPlatforms(kind) {
  if (kind === "mac-software") return ["macos"];
  // software, iOS app
  return ["ios", "ipados"];
}