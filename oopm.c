#include<stdio.h>
int length;
int breadth;
int area (int length ,int breadth){
    return length*breadth;
}
int perimeter(int lenghth,int breadth){
    return 2*(lenghth+breadth);
}
int main(){
    printf("enter the length:");
    scanf("%d",&length);
    printf("enter the breadth");
    scanf("%d",&breadth);
    printf("area:%d",area(length,breadth));
    printf("perimeter:%d",perimeter(length,breadth));
}