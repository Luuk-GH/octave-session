% Demo script for Run File (F5), Run Section (Ctrl+Enter) and Run Selection (F9).
a = 1;

%% Second section
b = a + 1;
fprintf('b = %d\n', b);

%% Third section: a loop
total = 0;
for k = 1:b
  total = total + k;
end
fprintf('total = %d\n', total);

%% Plot
x = linspace(0, 2*pi, 200);
plot(x, sin(x));
title('Run Section demo');
