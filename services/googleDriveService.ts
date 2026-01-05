/**
 * SERVICE FOR GOOGLE DRIVE INTEGRATION
 * Replace 'YOUR_GOOGLE_CLIENT_ID' with one of your existing Client IDs from the console.
 */
const CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';

let accessToken: string | null = null;

/**
 * Initiates the Google OAuth 2.0 flow to get an access token.
 */
export const authenticateGoogleDrive = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (accessToken) return resolve(accessToken);

    if (!(window as any).google?.accounts?.oauth2) {
      return reject(new Error('Google Identity Services not loaded. Please refresh.'));
    }

    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (response: any) => {
        if (response.error) {
          return reject(response);
        }
        accessToken = response.access_token;
        resolve(accessToken!);
      },
    });

    client.requestAccessToken();
  });
};

/**
 * Lists .zip and .json files from the user's Drive.
 */
export const listFilesFromDrive = async (): Promise<any[]> => {
  const token = await authenticateGoogleDrive();
  
  // Search for zip or json files
  const q = "mimeType = 'application/zip' or mimeType = 'application/json' or name contains '.aln_project.zip' or name contains '.aln_backup.json'";
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  if (!response.ok) throw new Error('Failed to fetch file list from Drive');
  const data = await response.json();
  return data.files || [];
};

/**
 * Downloads a file from Drive as a Blob.
 */
export const fetchFileFromDrive = async (fileId: string): Promise<Blob> => {
  const token = await authenticateGoogleDrive();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  if (!response.ok) throw new Error('Failed to download file from Drive');
  return await response.blob();
};

/**
 * Uploads a Blob (ZIP) to the user's Google Drive.
 */
export const uploadFileToDrive = async (blob: Blob, fileName: string): Promise<string> => {
  const token = await authenticateGoogleDrive();

  const metadata = {
    name: fileName,
    mimeType: 'application/zip',
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to upload to Google Drive');
  }

  const result = await response.json();
  return result.id;
};