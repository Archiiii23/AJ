#include<stdio.h>
int main(){
    int n=5;
    int t1=0;
    int t2=1;
    int next;
    for(int i=1;i<=n;i++){
        printf("%d",t1);
        next=t1+t2;
        t1=t2;
        t2=next;
    }
    return 0;
}