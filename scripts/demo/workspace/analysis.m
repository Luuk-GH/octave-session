%% Load the scores
data  = [72 85 91 64 78 88 95 70];
names = {"Ana", "Ben", "Cai", "Dee", "Eli", "Fay", "Gus", "Hal"};

%% Summary statistics
s = score_summary(data);
printf("mean %.1f, std %.1f\n", s.mean, s.std);

%% Grades
grades = repmat('C', size(data));
grades(data >= 80) = 'B';
grades(data >= 90) = 'A';
disp(grades)
