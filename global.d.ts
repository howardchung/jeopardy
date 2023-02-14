type StringDict = { [key: string]: string };
type NumberDict = { [key: string]: number };
type BooleanDict = { [key: string]: boolean | null };
type PCDict = { [key: string]: RTCPeerConnection };

interface User {
  id: string;
  isVideoChat?: boolean;
  isScreenShare?: boolean;
  isController?: boolean;
}

interface ChatMessage {
  timestamp: string;
  videoTS?: number;
  id: string;
  cmd: string;
  msg: string;
}
