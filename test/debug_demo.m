% Debugger demo: set breakpoints on the lines marked below, then press F5.
a = 1;
b = [1 2 3; 4 5 6];
s.name = "demo";
s.value = 42;
c = {1, "two", [3 4]};
total = debug_helper(a, b);   % step in here
disp(total)
for k = 1:3
  a = a + k;                 % breakpoint in a loop
end
fprintf("a = %d\n", a);
