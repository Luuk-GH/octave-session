function s = score_summary(x)
  % Summary statistics for a vector of scores.
  s.n = numel(x);
  s.mean = mean(x);
  s.std = std(x);
  s.range = [min(x) max(x)];
end
