function out = moving_avg (x, w)
  out = [];
  for i = 1:length (x) - w
    s = 0;
    for j = i:i+w-1
      s = s + x(j);
    end
    out(end+1) = s / w;
  end
  if (out == 0)
    eval ("disp ('all zero')");
  end
end
