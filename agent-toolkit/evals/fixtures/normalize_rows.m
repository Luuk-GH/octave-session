function Y = normalize_rows (X)
  % Y = normalize_rows (X) scales each row of X to unit Euclidean length.
  % Rows that are all zero are left as zeros.
  if (nargin != 1)
    print_usage ();
  end
  n = sqrt (sum (X .^ 2, 2));
  n(n == 0) = 1;
  Y = X ./ n;
end
