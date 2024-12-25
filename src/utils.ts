import axios from 'axios';

export function formatTimestamp(input: any) {
  if (
    input === null ||
    input === undefined ||
    input === false ||
    Number.isNaN(input) ||
    input === Infinity
  ) {
    return '';
  }
  let minutes = Math.floor(Number(input) / 60);
  let seconds = Math.floor(Number(input) % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function hashString(input: string) {
  var hash = 0;
  for (var i = 0; i < input.length; i++) {
    var charCode = input.charCodeAt(i);
    hash += charCode;
  }
  return hash;
}

let colorCache: Record<string, number> = {};
export function getColor(id: string) {
  let colors = [
    'red',
    'orange',
    'yellow',
    'olive',
    'green',
    'teal',
    'blue',
    'violet',
    'purple',
    'pink',
    'brown',
    'grey',
  ];
  if (colorCache[id]) {
    return colors[colorCache[id]];
  }
  colorCache[id] = Math.abs(hashString(id)) % colors.length;
  return colors[colorCache[id]];
}

export function getColorHex(id: string) {
  let mappings: Record<string, string> = {
    red: 'B03060',
    orange: 'FE9A76',
    yellow: 'FFD700',
    olive: '32CD32',
    green: '016936',
    teal: '008080',
    blue: '0E6EB8',
    violet: 'EE82EE',
    purple: 'B413EC',
    pink: 'FF1493',
    brown: 'A52A2A',
    grey: 'A0A0A0',
    black: '000000',
  };
  return mappings[getColor(id)];
}

export function decodeEntities(input: string) {
  const doc = new DOMParser().parseFromString(input, 'text/html');
  return doc.documentElement.textContent;
}

export const getDefaultPicture = (name: string, background = 'a0a0a0') => {
  return `https://ui-avatars.com/api/?name=${name}&background=${background}&size=256&color=ffffff`;
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
  `${window.location.protocol}//${window.location.hostname}${
    process.env.NODE_ENV === 'production' ? '' : ':8082'
  }`;

export async function generateName(): Promise<string> {
  const response = await axios.get<string>(serverPath + '/generateName');
  return response.data;
}

export function getOrCreateClientId() {
  let clientId = window.localStorage.getItem('jeopardy-clientid');
  if (!clientId) {
    // Generate a new clientID and save it
    clientId = crypto.randomUUID ? crypto.randomUUID() : uuidv4();
    window.localStorage.setItem('jeopardy-clientid', clientId);
  }
  return clientId;
}

function uuidv4() {
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}