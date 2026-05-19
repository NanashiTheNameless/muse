import getYouTubeIDModule from 'get-youtube-id';

type GetYouTubeID = (url: string, opts?: {fuzzy: boolean}) => string | null;

const getYouTubeID = getYouTubeIDModule as unknown as GetYouTubeID;

export default getYouTubeID;