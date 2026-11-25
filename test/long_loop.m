% Runs until interrupted. Press Ctrl+C in the Octave terminal (or click the status bar item).
n = 0;
while true
  n = n + 1;
  if mod(n, 5e6) == 0
    fprintf('still running, n = %d\n', n);
  end
end
