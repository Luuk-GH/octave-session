function counts = bin_scores (scores, edges)
  % Count how many scores fall in each bin [edges(k), edges(k+1)).
  counts = zeros (1, numel (edges));
  for k = 1:numel (edges)
    in_bin = scores >= edges(k) & scores < edges(k+1);
    counts(k) = sum (in_bin);
  end
end
