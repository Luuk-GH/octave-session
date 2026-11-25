% SYNTAX_DEMO  Exercises the Octave grammar: open it to check the colours.
# Octave also accepts hash comments.
%{
Block comment: if/for/end in here are not keywords.
%}
%% Numbers, strings and transposes
n = [1, -2.5e3, 0x1F, 3i, .5, Inf, NaN, pi];
s1 = 'It''s a single-quoted string';
s2 = "Double with \"escapes\" and %d placeholders\n";
A = magic(4);
B = A' * A.';                 % transpose, not a string
C = [A(1, :)' 'x'];           % transpose, then a string inside brackets
last = A(end, end-1) + n(end);
msg = sprintf('%5.2f | %s\n', pi, s1);

%% Control flow
total = 0;
for k = 1:numel(n)
  if isfinite(n(k)) && n(k) > 0
    total += n(k);
  elseif k == 2
    continue
  else
    total = total - 1;
  endif
end
switch lower(s1(1))
  case {'i', 'j'}
    disp('starts with i or j');
  otherwise
    disp(s1);
endswitch
try
  error('demo:id', 'Something went wrong: %s', msg);
catch err
  warning(err.identifier);
end_try_catch
do
  total--;
until total < 0
unwind_protect
  fid = fopen('demo.txt', 'w');
unwind_protect_cleanup
  fclose(fid);
end_unwind_protect

%% Command syntax, structs, cells and handles
hold on
pkg load statistics
s.name = "demo";
s.end = 3;                    % a field called end
c = {1, 'two', [3 4]};
f = @(x) x.^2 + 1;
y = cellfun(@numel, c);
long = 1 + 2 + ...            continuation comment
       3;
global counter
persistent cache

%% Local functions
function [out, count] = scale_values(values, factor)
  % Help text for a local function.
  out = values * factor;
  count = numel(out);
end

function r = helper(~)
  r = true;
end
