export async function startCapture(
  displayMediaOptions: DisplayMediaStreamOptions
): Promise<MediaStream | null> {
  let captureStream: MediaStream | null = null;
  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia(
      displayMediaOptions
    );
  } catch (err: any) {
    console.error(`Error: ${err}`);
  }
  return captureStream;
}
