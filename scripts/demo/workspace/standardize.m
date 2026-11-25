function z = standardize(x)
  % Scale scores to zero mean and unit standard deviation.
  z = (x - mean(x)) ./ sd;
end
