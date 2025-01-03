import { cyrb53 } from './hash';

// Given input text, gets back an mp3 file URL
// We can send this to each client and have it be read
// The RVC server caches for repeated inputs, so duplicate requests are fast
// Without GPU acceleration this is kinda slow to do in real time, so we may need to add support to pre-generate audio clips for specific game
export async function genAITextToSpeech(
  rvcHost: string,
  text: string,
): Promise<string | undefined> {
  if (text.length > 10000 || !text.length) {
    return;
  }
  const resp = await fetch(rvcHost + '/gradio_api/call/partial_36', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: [
        text,
        'Trebek',
        'en-US-ChristopherNeural',
        0,
        0,
        0,
        0,
        0,
        ['rmvpe'],
        0.5,
        3,
        0.25,
        0.33,
        128,
        true,
        false,
        1,
        true,
        0.7,
        'contentvec',
        '',
        0,
        0,
        44100,
        'mp3',
        cyrb53(text).toString(),
      ],
    }),
  });
  const info = await resp.json();
  // console.log(info);
  // Fetch the result
  const fetchUrl = rvcHost + '/gradio_api/call/partial_36/' + info.event_id;
  // console.log(fetchUrl);
  const resp2 = await fetch(fetchUrl);
  const info2 = await resp2.text();
  // console.log(info2);
  const lines = info2.split('\n');
  // Find the line after complete
  const completeIndex = lines.indexOf('event: complete');
  const target = lines[completeIndex + 1];
  if (target.startsWith('data: ')) {
    // Take off the prefix, parse the array as json and get the first element
    const arr = JSON.parse(target.slice(6));
    // Fix the path /grad/gradio_api/file to /gradio_api/file
    const url = arr[0].url.replace('/grad/gradio_api/file', '/gradio_api/file');
    // console.log(url);
    return url;
  }
  return;
}
