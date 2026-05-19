export default (width: number, progress: number): string => {
  const dotPosition = Math.floor(width * progress);

  let res = '';

  for (let i = 0; i < width; i++) {
    if (i === dotPosition) {
      res += 'o';
    } else {
      res += '-';
    }
  }

  return res;
};
