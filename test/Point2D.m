classdef (Sealed) Point2D < handle
  % POINT2D  A point in the plane (classdef syntax demo).

  properties (Access = public)
    X = 0;     % x coordinate
    Y = 0;     % y coordinate
  end

  properties (Constant)
    Origin = [0 0];
  end

  events
    Moved
  end

  methods
    function obj = Point2D(x, y)
      if nargin > 0
        obj.X = x;
        obj.Y = y;
      end
    end

    function d = distance(obj, other)
      d = sqrt((obj.X - other.X)^2 + (obj.Y - other.Y)^2);
    end

    function move(obj, dx, dy)
      obj.X += dx;
      obj.Y += dy;
      notify(obj, 'Moved');
    end
  end
end
