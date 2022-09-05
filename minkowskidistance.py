def minkowskidistance(x,y,p):
    import math
    import numpy as np 
    zipped_coordinate = zip(x,y)
    return math.pow(np.sum([math.pow(np.abs(i[0]-i[1]),p) for i in zipped_coordinate]) , 1/p)
