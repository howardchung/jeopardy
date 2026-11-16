import { cyrb53 } from "../server/hash";

export function formatTimestamp(input: any) {
  if (
    input === null ||
    input === undefined ||
    input === false ||
    Number.isNaN(input) ||
    input === Infinity
  ) {
    return "";
  }
  let minutes = Math.floor(Number(input) / 60);
  let seconds = Math.floor(Number(input) % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

let colorCache: Record<string, number> = {};
export function getColor(id: string) {
  let colors = [
    "red",
    "orange",
    "yellow",
    "olive",
    "green",
    "teal",
    "blue",
    "violet",
    "purple",
    "pink",
    "brown",
    "grey",
  ];
  if (colorCache[id]) {
    return colors[colorCache[id]];
  }
  colorCache[id] = Math.abs(cyrb53(id)) % colors.length;
  return colors[colorCache[id]];
}

export function getColorHex(id: string) {
  let mappings: Record<string, string> = {
    red: "B03060",
    orange: "FE9A76",
    yellow: "FFD700",
    olive: "32CD32",
    green: "016936",
    teal: "008080",
    blue: "0E6EB8",
    violet: "EE82EE",
    purple: "B413EC",
    pink: "FF1493",
    brown: "A52A2A",
    grey: "A0A0A0",
    black: "000000",
  };
  return mappings[getColor(id)];
}

export function decodeEntities(input: string) {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return doc.documentElement.textContent;
}

export const getDefaultPicture = (name: string, background = "a0a0a0") => {
  const fg = background.startsWith("#") ? background : `#${background}`;
  const hash = Math.abs(cyrb53(name || "?"));
  const size = 5;
  const cell = 20;
  const pad = 15;
  const total = size * cell + pad * 2;

  const rects: string[] = [];
  let bit = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < 3; col++) {
      const filled = ((hash >>> bit) & 1) === 1;
      bit++;
      if (filled) {
        const x = pad + col * cell;
        const y = pad + row * cell;
        rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}"/>`);
        const mirrorCol = size - 1 - col;
        if (mirrorCol !== col) {
          const mx = pad + mirrorCol * cell;
          rects.push(
            `<rect x="${mx}" y="${y}" width="${cell}" height="${cell}"/>`,
          );
        }
      }
    }
  }
  if (rects.length === 0) {
    const center = pad + 2 * cell;
    rects.push(
      `<rect x="${center}" y="${center}" width="${cell}" height="${cell}"/>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#0e162b"/><g fill="${fg}">${rects.join("")}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const isMobile = () => {
  return window.screen.width <= 600;
};

export function shuffle(array: any[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
}

export const serverPath =
  import.meta.env.VITE_SERVER_HOST ||
  `${window.location.protocol}//${
    import.meta.env.DEV
      ? `${window.location.hostname}:8083`
      : window.location.host
  }`;

export async function generateName(): Promise<string> {
  const response = await fetch(serverPath + "/generateName");
  return response.text();
}

export function getOrCreateClientId() {
  let clientId = window.localStorage.getItem("jeopardy-clientid");
  if (!clientId) {
    // Generate a new clientID and save it
    clientId = crypto.randomUUID ? crypto.randomUUID() : uuidv4();
    window.localStorage.setItem("jeopardy-clientid", clientId);
  }
  return clientId;
}

function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}
