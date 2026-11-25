% Histogram of exam scores per 10-point band.
scores = [55 62 71 88 93 47 79 85 68 90 100];
edges = 40:10:100;
counts = bin_scores (scores, edges);
for k = 1:numel (counts)
  printf ("%3d-%3d: %d\n", edges(k), edges(k+1), counts(k));
end
printf ("total: %d of %d scores\n", sum (counts), numel (scores));
