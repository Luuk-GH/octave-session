function out = debug_helper(x, m)
  % Helper for debug_demo.m: a function frame with its own workspace.
  scale = 2;
  out = x + sum(m(:)) * scale;
  out = inner(out);
end

function y = inner(v)
  y = v - 1;
end
